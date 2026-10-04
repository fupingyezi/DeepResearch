/**
 * RedisRunRegistry —— RunRegistry 的跨进程实现。
 *
 * Redis 承载三块协调状态（均为协调元数据，run 的最终真相在 PG）：
 * - `deerflow:run:owner:{runId}`：Hash（threadId/owner/startedAt），带 TTL ——
 *   owner 路由表，取消请求据此判断 run 是否存在；TTL 兜底僵尸登记（owner
 *   进程崩溃后自行过期）；
 * - `deerflow:thread:running:{threadId}`：Set —— thread 名下在跑的 run 索引，
 *   每次登记刷新 TTL（「等收尾」轮询该集合，见 service 的 waitForRunsDrained）；
 * - `deerflow:run:cancel`：Pub/Sub 频道 —— 取消请求广播，各进程订阅后查本地
 *   句柄表，owner 才真正 abort。node-redis 断线重连后自动重新订阅。
 *
 * 降级语义：REDIS_URL 未配置 / 连接失败 / 任一操作失败 → 永久降级为进程内
 * 实现（只告警一次）。降级后单进程内语义仍完整（取消直接回调 handler），
 * 跨进程协调失效（多进程部署下变为尽力而为）。
 *
 * requestCancel 返回「投递数」而非「命中数」：跨进程无法同步拿到远端 handler
 * 回报，owner 登记存在且消息已发布即计 1（僵尸 owner 留下的悬挂登记由 TTL 兜底）。
 * 短窗口去重（SET NX）：同一 run 的重复取消请求只广播一次，重复点击停止返回 0。
 */

import { createClient } from 'redis';

import type { RunOwnerInfo, RunRegistry } from '../contracts';
import { InMemoryRunRegistry } from './in-memory';
import { getInstanceOwner } from '../instance-id';

type RedisClient = ReturnType<typeof createClient>;

const LOG = '[run-registry]';

const OWNER_KEY_PREFIX = 'deerflow:run:owner:';
const THREAD_RUNNING_KEY_PREFIX = 'deerflow:thread:running:';
const CANCEL_CHANNEL = 'deerflow:run:cancel';
const CANCEL_SEEN_KEY_PREFIX = 'deerflow:run:cancel:seen:';

/** 重复取消请求的短窗口去重 TTL：窗口内同一 run 只广播一次。 */
const CANCEL_SEEN_TTL_MS = 10_000;

/** owner 登记 TTL（DEERFLOW_RUN_OWNER_TTL_MS，默认 2h）：崩溃进程的悬挂登记自行过期。 */
const RUN_OWNER_TTL_S = (() => {
  const raw = Number(process.env.DEERFLOW_RUN_OWNER_TTL_MS);
  const ms = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2 * 60 * 60 * 1000;
  return Math.max(1, Math.floor(ms / 1000));
})();

const ownerKeyOf = (runId: string): string => `${OWNER_KEY_PREFIX}${runId}`;
const threadRunningKeyOf = (threadId: string): string => `${THREAD_RUNNING_KEY_PREFIX}${threadId}`;
const cancelSeenKeyOf = (runId: string): string => `${CANCEL_SEEN_KEY_PREFIX}${runId}`;

function parseOwnerInfo(runId: string, hash: Record<string, string>): RunOwnerInfo | null {
  if (!hash || !hash.threadId) return null;
  return {
    runId,
    threadId: hash.threadId,
    owner: hash.owner ?? '',
    startedAt: Number.parseInt(hash.startedAt ?? '0', 10) || 0,
  };
}

export class RedisRunRegistry implements RunRegistry {
  private client: RedisClient | null = null;
  private subClient: RedisClient | null = null;
  private connecting: Promise<RedisClient | null> | null = null;
  private connected = false;
  private degraded = false;
  private degradeWarned = false;
  private subscribed = false;
  private readonly handlers: Array<(runId: string, reason: string) => number> = [];
  private readonly fallback = new InMemoryRunRegistry();
  /** runId → threadId 本进程登记镜像：owner Hash 过期后 unregister 仍能清 thread 索引。 */
  private readonly localThreads = new Map<string, string>();

  constructor(options?: { client?: RedisClient; subClient?: RedisClient }) {
    if (options?.client) {
      this.client = options.client;
      this.subClient = options.subClient ?? options.client;
      this.connected = true;
    }
  }

  isDistributed(): boolean {
    return this.connected && !this.degraded;
  }

  async register(info: RunOwnerInfo): Promise<void> {
    this.localThreads.set(info.runId, info.threadId);
    const client = await this.ensureClient();
    if (!client) {
      await this.fallback.register(info);
      return;
    }
    try {
      const ownerKey = ownerKeyOf(info.runId);
      await client.hSet(ownerKey, {
        threadId: info.threadId,
        owner: info.owner,
        startedAt: String(info.startedAt),
      });
      await client.expire(ownerKey, RUN_OWNER_TTL_S);
      const threadKey = threadRunningKeyOf(info.threadId);
      await client.sAdd(threadKey, info.runId);
      await client.expire(threadKey, RUN_OWNER_TTL_S);
      await this.ensureSubscribed();
    } catch (error) {
      await this.degradeAnd(() => this.fallback.register(info), error);
    }
  }

  async unregister(runId: string): Promise<void> {
    const client = await this.ensureClient();
    if (!client) {
      await this.fallback.unregister(runId);
      return;
    }
    try {
      // threadId 优先取本进程登记镜像；镜像缺失（进程重启后清理遗留登记）时回读 owner Hash
      let threadId = this.localThreads.get(runId);
      if (!threadId) {
        const hash = await client.hGetAll(ownerKeyOf(runId));
        threadId = hash.threadId;
      }
      if (threadId) await client.sRem(threadRunningKeyOf(threadId), runId);
      await client.del(ownerKeyOf(runId));
    } catch (error) {
      await this.degradeAnd(() => this.fallback.unregister(runId), error);
    }
    this.localThreads.delete(runId);
  }

  async ownerOf(runId: string): Promise<RunOwnerInfo | null> {
    const client = await this.ensureClient();
    if (!client) return this.fallback.ownerOf(runId);
    try {
      return parseOwnerInfo(runId, await client.hGetAll(ownerKeyOf(runId)));
    } catch (error) {
      return this.degradeAnd(() => this.fallback.ownerOf(runId), error);
    }
  }

  async listByThread(threadId: string): Promise<RunOwnerInfo[]> {
    const client = await this.ensureClient();
    if (!client) return this.fallback.listByThread(threadId);
    try {
      const runIds = await client.sMembers(threadRunningKeyOf(threadId));
      const out: RunOwnerInfo[] = [];
      for (const runId of runIds) {
        // 悬挂索引（owner Hash 已过期）跳过：索引是投影，Hash 才是登记真相
        const parsed = parseOwnerInfo(runId, await client.hGetAll(ownerKeyOf(runId)));
        if (parsed) out.push(parsed);
      }
      return out;
    } catch (error) {
      return this.degradeAnd(() => this.fallback.listByThread(threadId), error);
    }
  }

  async requestCancel(runId: string, reason: string): Promise<number> {
    const client = await this.ensureClient();
    if (!client) return this.fallback.requestCancel(runId, reason);
    try {
      const owner = parseOwnerInfo(runId, await client.hGetAll(ownerKeyOf(runId)));
      if (!owner) return 0;
      const seen = await client.set(cancelSeenKeyOf(runId), '1', {
        NX: true,
        PX: CANCEL_SEEN_TTL_MS,
      });
      if (seen !== 'OK') return 0;
      const receivers = await client.publish(
        CANCEL_CHANNEL,
        JSON.stringify({ runId, reason, issuedBy: getInstanceOwner() }),
      );
      return receivers > 0 ? 1 : 0;
    } catch (error) {
      return this.degradeAnd(() => this.fallback.requestCancel(runId, reason), error);
    }
  }

  onCancelRequest(handler: (runId: string, reason: string) => number): void {
    this.handlers.push(handler);
    // 降级后取消请求走进程内直调，fallback 也需要同一份 handler
    this.fallback.onCancelRequest(handler);
  }

  async close(): Promise<void> {
    if (this.subClient) {
      await this.subClient.quit().catch(() => undefined);
    }
    if (this.client) {
      await this.client.quit().catch(() => undefined);
    }
    this.subClient = null;
    this.client = null;
    this.connected = false;
  }

  /** 收到频道广播：回调本进程 handler，owner（句柄表命中）才真正 abort。 */
  private deliverCancelMessage(raw: string): void {
    let parsed: { runId?: unknown; reason?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed.runId !== 'string') return;
    const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
    let hits = 0;
    for (const handler of this.handlers) {
      try {
        hits += handler(parsed.runId, reason);
      } catch (error) {
        console.warn(`${LOG} cancel handler failed:`, (error as Error)?.message);
      }
    }
    if (hits > 0) {
      console.info(`${LOG} cancel delivered run_id=${parsed.runId} reason=${reason}`);
    }
  }

  private async ensureSubscribed(): Promise<void> {
    if (this.subscribed || this.degraded) return;
    const sub = this.subClient;
    if (!sub) return;
    try {
      // 订阅必须走独立连接：v5 中 subscribe 之后该连接进入仅订阅上下文，
      // 命令与 publish 都会被拒，与主连接的读写必须分离
      await sub.subscribe(CANCEL_CHANNEL, (message) => {
        this.deliverCancelMessage(message);
      });
      this.subscribed = true;
    } catch (error) {
      this.enterDegraded((error as Error)?.message ?? String(error));
    }
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
      const sub = client.duplicate();
      sub.on('error', (err) => {
        console.warn(`${LOG} Redis subscriber error:`, err.message);
      });
      await sub.connect();
      this.subClient = sub;
      await this.ensureSubscribed();
      console.info(`${LOG} 已连接 Redis，启用跨进程 run 协调`);
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
      console.warn(`${LOG} 降级为进程内登记表（单进程正确，多进程尽力而为）。原因: ${reason}`);
    }
  }

  private degradeAnd<T>(fallback: () => T, error: unknown): T {
    this.enterDegraded((error as Error)?.message ?? String(error));
    return fallback();
  }
}
