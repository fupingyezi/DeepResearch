/**
 * InMemoryRunEventBus —— RunEventBus 的进程内实现：直包 StreamBridge。
 *
 * - 游标：publish 时按 run 贴单调递增序号（十进制字符串），subscribe(fromEventId)
 *   只交付序号严格晚于游标的事件——断点续读不依赖订阅时间点
 * - 回放 / 实时语义（快照 + pending 不丢不重）都在 ThreadChannel 里，本类
 *   只做游标与生命周期管理
 * - release：drop channel 释放内存（buffer 上限内的全部事件），并留墓碑——
 *   已释放的 run 再订阅立即结束（空流），不让重连请求挂在永不 close 的空
 *   channel 上；终态补齐由重连路由按 runs 状态合成
 */

import type { ClientAgentEvent, StampedClientAgentEvent } from '../sse/client-event';
import { StreamBridge } from '../stream-bridge';
import type { RunEventBus } from '../contracts';

const keyOf = (threadId: string, runId: string): string => `${threadId}:${runId}`;

/** 墓碑保留时长：长于释放窗口后即可清理（清理只影响再订阅的判定，无数据）。 */
const TOMBSTONE_TTL_MS = 60 * 60_000;

/** 空流：已释放的 run 再订阅立即结束，不挂起。 */
function emptyStampedStream(): AsyncIterable<StampedClientAgentEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<StampedClientAgentEvent> {
      return {
        async next() {
          return { value: undefined, done: true };
        },
      };
    },
  };
}

export class InMemoryRunEventBus implements RunEventBus {
  private readonly bridge: StreamBridge<StampedClientAgentEvent>;
  /** run → 已发的最大序号。 */
  private readonly seq = new Map<string, number>();
  /** 已释放 run 的墓碑：key → releasedAt。 */
  private readonly releasedAt = new Map<string, number>();

  constructor(bridge?: StreamBridge<StampedClientAgentEvent>) {
    this.bridge = bridge ?? new StreamBridge<StampedClientAgentEvent>((s) => s.event.eventType);
  }

  publish(threadId: string, runId: string, event: ClientAgentEvent): Promise<void> {
    const key = keyOf(threadId, runId);
    // 新 publish 开始新一轮生命周期：清墓碑（墓碑只门控已死的 channel，防重连挂起）
    this.releasedAt.delete(key);
    const next = (this.seq.get(key) ?? 0) + 1;
    this.seq.set(key, next);
    this.bridge.channel(threadId, runId).publish({ eventId: String(next), event });
    return Promise.resolve();
  }

  subscribe(
    threadId: string,
    runId: string,
    fromEventId?: string,
  ): AsyncIterable<StampedClientAgentEvent> {
    const key = keyOf(threadId, runId);
    if (this.releasedAt.has(key)) return emptyStampedStream();
    // 游标非法 / 缺省 = 全量回放
    const cursor = Number.parseInt(fromEventId ?? '', 10);
    const from = Number.isFinite(cursor) ? cursor : 0;
    const channel = this.bridge.channel(threadId, runId);
    // 过滤发生在交付侧：channel 本身照常全量分发，只有晚于游标的事件出门
    return (async function* () {
      for await (const stamped of channel.subscribe()) {
        if (Number(stamped.eventId) > from) yield stamped;
      }
    })();
  }

  release(threadId: string, runId: string): Promise<void> {
    const key = keyOf(threadId, runId);
    this.bridge.drop(threadId, runId);
    this.seq.delete(key);
    this.releasedAt.set(key, Date.now());
    // 顺手清理过期墓碑（每次释放至多线性扫描一遍，规模有界）
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    for (const [k, at] of this.releasedAt) {
      if (at < cutoff) this.releasedAt.delete(k);
    }
    return Promise.resolve();
  }

  async ready(): Promise<void> {
    // 无连接可建立
  }

  isDistributed(): boolean {
    return false;
  }
}
