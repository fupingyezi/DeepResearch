/**
 * StreamBridge —— 进程内 thread+run 多订阅事件总线
 *
 * 设计：
 * - 事件载荷直接复用 `ClientAgentEvent`（discriminated union），零自造类型
 * - ThreadChannel 内部维护 `buffer` 与 `EventEmitter`：晚订阅可拿历史
 * - 收到 END / 不可恢复 ERROR 后自然终止，并在 drop 时清理监听器
 *
 * 多实例部署时，把 EventEmitter 换成 Redis pub/sub 即可，接口保持稳定。
 */

import { EventEmitter } from 'node:events';

import { ClientAgentEventType, type ClientAgentEvent } from '../sse/client-event';

const EV = 'ev';

export class ThreadChannel {
  private readonly bus = new EventEmitter();
  private readonly buffer: ClientAgentEvent[] = [];
  private closed = false;

  constructor(
    public readonly threadId: string,
    public readonly runId: string,
  ) {
    // 防止"超过 10 个监听器"警告（晚订阅多客户端场景）
    this.bus.setMaxListeners(0);
  }

  isClosed(): boolean {
    return this.closed;
  }

  publish(ev: ClientAgentEvent): void {
    if (this.closed) return;
    this.buffer.push(ev);
    this.bus.emit(EV, ev);
    // END 一律视为终止；ERROR 仅在 recoverable=false 时终止
    if (ev.eventType === ClientAgentEventType.END) {
      this.close();
      return;
    }
    if (
      ev.eventType === ClientAgentEventType.ERROR &&
      ev.payload &&
      ev.payload.recoverable === false
    ) {
      // 不立即 close —— 让消费者读到 ERROR 帧后再关闭
      // 终止由 publish END 兜底
    }
  }

  /** 返回一个 AsyncIterable，先回放 buffer，再监听后续事件。 */
  subscribe(): AsyncIterable<ClientAgentEvent> {
    const buffered = this.buffer.slice(); // 快照，避免之后 push 影响回放索引
    const bus = this.bus;
    const isClosed = () => this.closed;

    return {
      [Symbol.asyncIterator](): AsyncIterator<ClientAgentEvent> {
        let i = 0;
        // 后续事件队列：当回放完成后到达的 publish 进这里；保证不丢事件
        const pending: ClientAgentEvent[] = [];
        let resolveNext: ((v: IteratorResult<ClientAgentEvent>) => void) | null = null;

        const onEv = (ev: ClientAgentEvent) => {
          if (resolveNext) {
            const r = resolveNext;
            resolveNext = null;
            r({ value: ev, done: false });
          } else {
            pending.push(ev);
          }
        };
        bus.on(EV, onEv);

        const cleanup = () => {
          bus.off(EV, onEv);
        };

        return {
          async next(): Promise<IteratorResult<ClientAgentEvent>> {
            // 1) 回放历史
            if (i < buffered.length) {
              return { value: buffered[i++], done: false };
            }
            // 2) 已有未消费的实时事件
            if (pending.length > 0) {
              return { value: pending.shift() as ClientAgentEvent, done: false };
            }
            // 3) 已 close 且无残留 → 终止
            if (isClosed()) {
              cleanup();
              return { value: undefined, done: true };
            }
            // 4) 等待下一个事件
            return new Promise<IteratorResult<ClientAgentEvent>>((resolve) => {
              resolveNext = resolve;
            });
          },
          async return(): Promise<IteratorResult<ClientAgentEvent>> {
            cleanup();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // 唤醒所有挂起的 next()
    this.bus.emit(EV, {
      eventType: ClientAgentEventType.END,
      timestamp: Date.now(),
      agentId: 'system',
      payload: {},
    } satisfies ClientAgentEvent);
    this.bus.removeAllListeners();
  }
}

export class StreamBridge {
  private readonly channels = new Map<string, ThreadChannel>();

  private static key(threadId: string, runId: string): string {
    return `${threadId}:${runId}`;
  }

  channel(threadId: string, runId: string): ThreadChannel {
    const k = StreamBridge.key(threadId, runId);
    let ch = this.channels.get(k);
    if (!ch) {
      ch = new ThreadChannel(threadId, runId);
      this.channels.set(k, ch);
    }
    return ch;
  }

  drop(threadId: string, runId: string): void {
    const k = StreamBridge.key(threadId, runId);
    const ch = this.channels.get(k);
    if (ch) {
      ch.close();
      this.channels.delete(k);
    }
  }

  size(): number {
    return this.channels.size;
  }
}

/** 进程内单例 —— 所有路由共用同一总线 */
export const streamBridge = new StreamBridge();
