/**
 * RedisEventBus —— RunEventBus 的跨进程实现：Redis Stream 承载事件流。
 *
 * - `deerflow:stream:{threadId}:{runId}`：每条事件 XADD 一条 entry（field `e`
 *   存 JSON），entry id 即续读游标——XADD 自增 id 天然 per-run 单调递增
 * - 裁剪与 TTL：XADD 内联 TRIM MAXLEN ~2000（与进程内 buffer 上限对齐），
 *   每次发布刷新 EXPIRE 24h——TTL 从最后一条事件起算，run 结束 24h 后自动回收；
 *   run 中无事件静默期也会由下一次 publish 顺延
 * - 订阅：独立连接 XREAD BLOCK 续读（阻塞读会占住连接的命令队列，不能与发布
 *   共用连接）。首次订阅从游标（缺省全量）读起；BLOCK 超时且本订阅见过事件时
 *   查一次 key 是否存在（EXPIRE 清理 = run 早已结束 → 终止）——从未见过事件的
 *   流可能是 run 尚未产出首条事件（stream 随首个 XADD 才创建），不能判死。
 *   连接中断退避后以同一游标重发——XREAD 幂等，断点续读不丢不重
 * - 无 END 的悬挂流（owner 崩溃）本实现不终止订阅，由重连路由按 runs 终态补尾
 *
 * 降级语义：REDIS_URL 未配置 / 连接失败 / 操作失败 → 永久降级进程内实现
 * （只告警一次）。降级后单进程内语义完整，跨进程回放失效。
 */

import { createClient } from 'redis';

import {
  ClientAgentEventType,
  type ClientAgentEvent,
  type StampedClientAgentEvent,
} from '../sse/client-event';
import type { RunEventBus } from '../contracts';
import { InMemoryRunEventBus } from './in-memory';

type RedisClient = ReturnType<typeof createClient>;

const LOG = '[event-bus]';

const STREAM_KEY_PREFIX = 'deerflow:stream:';
/** 事件流保留窗口：从最后一条事件起算，覆盖断点重连的合理时间跨度。 */
const STREAM_TTL_S = 24 * 60 * 60;
/** 单次 XREAD 批量条数上限：长回放分段交付，避免单次往返吞进整个流。 */
const XREAD_COUNT = 64;
/** 游标形态：XADD 自增 id（`{毫秒}-{序号}`）；非法游标按全量回放。 */
const CURSOR_RE = /^\d+-\d+$/;

const DEFAULT_MAXLEN = (() => {
  const raw = Number(process.env.STREAM_BRIDGE_BUFFER_MAX);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2000;
})();

const streamKeyOf = (threadId: string, runId: string): string =>
  `${STREAM_KEY_PREFIX}${threadId}:${runId}`;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class RedisEventBus implements RunEventBus {
  private client: RedisClient | null = null;
  private connecting: Promise<RedisClient | null> | null = null;
  private connected = false;
  private degraded = false;
  private degradeWarned = false;
  private readonly fallback = new InMemoryRunEventBus();
  private readonly maxlen: number;
  private readonly blockMs: number;

  constructor(options?: { client?: RedisClient; maxlen?: number; blockMs?: number }) {
    if (options?.client) {
      this.client = options.client;
      this.connected = true;
    }
    this.maxlen = options?.maxlen ?? DEFAULT_MAXLEN;
    this.blockMs = options?.blockMs ?? 5000;
  }

  isDistributed(): boolean {
    return this.connected && !this.degraded;
  }

  async publish(threadId: string, runId: string, event: ClientAgentEvent): Promise<void> {
    const client = await this.ensureClient();
    if (!client) {
      await this.fallback.publish(threadId, runId, event);
      return;
    }
    const key = streamKeyOf(threadId, runId);
    try {
      // XADD 内联 TRIM：发布与裁剪同一条命令，流长稳态不超过 maxlen
      await client.xAdd(
        key,
        '*',
        { e: JSON.stringify(event) },
        {
          TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: this.maxlen },
        },
      );
      await client.expire(key, STREAM_TTL_S);
    } catch (error) {
      await this.degradeAnd(() => this.fallback.publish(threadId, runId, event), error);
    }
  }

  subscribe(
    threadId: string,
    runId: string,
    fromEventId?: string,
  ): AsyncIterable<StampedClientAgentEvent> {
    // 订阅连接懒建立（迭代器首次 next 时）——调用方拿到的只是一层壳，
    // 不阻塞 submit 路径；连接失败在迭代内降级
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<StampedClientAgentEvent> =>
        this.startSubscription(threadId, runId, fromEventId),
    };
  }

  /** Redis stream 由 24h TTL 兜底回收；release 由 service 统一调度，此处无需动作。 */
  release(): Promise<void> {
    return Promise.resolve();
  }

  private async *startSubscription(
    threadId: string,
    runId: string,
    fromEventId?: string,
  ): AsyncGenerator<StampedClientAgentEvent> {
    if (this.degraded) {
      yield* this.fallback.subscribe(threadId, runId, fromEventId);
      return;
    }
    const client = await this.ensureClient();
    if (!client) {
      yield* this.fallback.subscribe(threadId, runId, fromEventId);
      return;
    }

    const sub = client.duplicate();
    sub.on('error', (err) => {
      console.warn(`${LOG} subscriber error:`, err.message);
    });
    try {
      await sub.connect();
    } catch (error) {
      this.enterDegraded((error as Error)?.message ?? String(error));
      yield* this.fallback.subscribe(threadId, runId, fromEventId);
      return;
    }

    const key = streamKeyOf(threadId, runId);
    let cursor = typeof fromEventId === 'string' && CURSOR_RE.test(fromEventId) ? fromEventId : '0';

    // RESP2 下 xRead 返回 [{name, messages: [{id, message}]}]；类型标注固定这条协议
    type XReadStream = {
      name: string;
      messages: Array<{ id: string; message: Record<string, string> }>;
    };

    try {
      // 本订阅是否见过事件：见过后流消失（TTL 回收）才判死；从未见过可能是
      // run 尚未产出首条事件（stream 随首个 XADD 才创建），不能因超时而终止
      let seenOnce = false;
      for (;;) {
        let entries: XReadStream[] | null;
        try {
          const pending = sub.xRead(
            { key, id: cursor },
            { BLOCK: this.blockMs, COUNT: XREAD_COUNT },
          );
          // 订阅被放弃（return()）时挂起中的 XREAD 以拒绝告终且无人消费，先吞掉
          (pending as unknown as Promise<unknown>).catch(() => undefined);
          entries = (await pending) as XReadStream[] | null;
        } catch (error) {
          // 连接中断 / 命令失败：退避后以同一游标重发（XREAD 幂等，不丢不重）
          console.warn(
            `${LOG} xread failed, retrying with cursor=${cursor}:`,
            (error as Error)?.message,
          );
          await delay(100);
          continue;
        }
        if (entries && entries.length > 0) {
          seenOnce = true;
          for (const stream of entries) {
            for (const msg of stream.messages) {
              cursor = msg.id;
              let event: ClientAgentEvent;
              try {
                event = JSON.parse(msg.message.e) as ClientAgentEvent;
              } catch (error) {
                console.warn(`${LOG} skip corrupt entry id=${msg.id}:`, (error as Error)?.message);
                continue;
              }
              yield { eventId: msg.id, event };
              if (event.eventType === ClientAgentEventType.END) return;
            }
          }
        } else if (seenOnce) {
          // BLOCK 超时无新事件且见过事件：流被 TTL 回收说明 run 早已结束；
          // 查询失败按仍存活处理，下一轮继续等待
          const alive = await sub.exists(key).catch(() => 1);
          if (alive === 0) return;
        }
      }
    } finally {
      await sub.quit().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.quit().catch(() => undefined);
    }
    this.client = null;
    this.connected = false;
  }

  /**
   * 懒连接 Redis。REDIS_URL 未配置或连接失败时返回 null（走进程内降级）。
   * 首次降级打印一次告警，避免刷屏。
   */
  private async ensureClient(): Promise<RedisClient | null> {
    if (this.degraded) return null;
    if (this.connected && this.client) return this.client;
    if (!process.env.REDIS_URL) {
      this.enterDegraded('REDIS_URL 未配置');
      return null;
    }
    if (!this.connecting) {
      this.connecting = this.connect();
    }
    return this.connecting;
  }

  private async connect(): Promise<RedisClient | null> {
    try {
      const client = createClient({
        url: process.env.REDIS_URL,
        socket: {
          keepAlive: true,
          connectTimeout: 10_000,
          reconnectStrategy: (retries) => {
            if (retries > 3) return new Error('Redis 重连次数过多');
            return Math.min(retries * 200, 3000);
          },
        },
      });
      client.on('error', (err) => {
        console.warn(`${LOG} Redis error:`, err.message);
      });
      await client.connect();
      this.client = client;
      this.connected = true;
      console.info(`${LOG} 已连接 Redis，启用事件流跨进程回放`);
      return client;
    } catch (error) {
      this.enterDegraded((error as Error)?.message ?? String(error));
      return null;
    } finally {
      this.connecting = null;
    }
  }

  private enterDegraded(reason: string): void {
    this.degraded = true;
    this.connected = false;
    if (!this.degradeWarned) {
      this.degradeWarned = true;
      console.warn(`${LOG} 降级为进程内事件总线（单进程正确，跨进程回放失效）。原因: ${reason}`);
    }
  }

  private async degradeAnd<T>(fallback: () => T, error: unknown): Promise<T> {
    this.enterDegraded((error as Error)?.message ?? String(error));
    return fallback();
  }
}
