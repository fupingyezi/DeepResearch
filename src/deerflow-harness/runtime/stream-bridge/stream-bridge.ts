/**
 * StreamBridge —— 进程内 thread+run 多订阅事件总线
 *
 * 设计：
 * - ThreadChannel 直接 extends 官方 `node:events` EventEmitter：10 个
 *   `ClientAgentEventType` 就是事件名（typed emit/on），事件载荷是完整的
 *   `ClientAgentEvent`（与前端 handler 签名统一）
 * - 事件分发语义（buffer 回放 / close 终止 / 关键帧保护）由 ThreadChannel 在
 *   EventEmitter 之上维护：`subscribe()` 返回 AsyncIterable，晚订阅可拿历史
 * - `close()` 用私有符号事件唤醒挂起的 `next()`，不再合成假的 system END 帧——
 *   内部唤醒信号不能以真实协议帧的形态漏给消费者
 *
 * 多实例部署时，把 EventEmitter 换成 Redis pub/sub 即可，`publish()` /
 * `subscribe()` 接口保持稳定。
 */

import { EventEmitter } from 'node:events';

import { ClientAgentEventType, type ClientAgentEvent } from '../sse/client-event';

/** close() 的内部唤醒信号：只给 subscribe() 挂起的 next() 用，不进 buffer、不对外。 */
const CLOSED_EVENT = Symbol('thread-channel-closed');

/**
 * 事件名 → 参数元组映射表：每个 ClientAgentEventType 对应 [该类型的判别成员]。
 * EventEmitter 泛型（@types/node 的 EventMap 约定）借此让 on<K>/emit<K> 在
 * 类型层把事件名与事件成员（含 payload 收窄）绑定。
 */
type ChannelEventMap = {
  [K in ClientAgentEventType]: [Extract<ClientAgentEvent, { eventType: K }>];
} & { [CLOSED_EVENT]: [] };

const ALL_EVENT_TYPES = Object.values(ClientAgentEventType) as ClientAgentEventType[];

/**
 * buffer 上限（条）。超限时丢弃最旧的非关键帧，防止超长运行线程的内存无界膨胀。
 * 触发条件：单 run 事件数超过上限；后果：晚订阅回放只能拿到裁剪后的尾部历史；
 * 对策：关键帧（START/ERROR/END/HUMAN_INTERRUPT）永不丢弃，保证回放语义完整。
 */
const DEFAULT_BUFFER_MAX = (() => {
  const raw = Number(process.env.STREAM_BRIDGE_BUFFER_MAX);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2000;
})();

/** 关键帧：影响订阅/回放语义，裁剪时必须保留。 */
const CRITICAL_EVENT_TYPES = new Set<ClientAgentEventType>([
  ClientAgentEventType.START,
  ClientAgentEventType.ERROR,
  ClientAgentEventType.END,
  ClientAgentEventType.HUMAN_INTERRUPT,
]);

export class ThreadChannel extends EventEmitter<ChannelEventMap> {
  private readonly buffer: ClientAgentEvent[] = [];
  private readonly bufferMax: number;
  private closed = false;
  private droppedCount = 0;

  constructor(
    public readonly threadId: string,
    public readonly runId: string,
    options?: { bufferMax?: number },
  ) {
    super();
    // 防止"超过 10 个监听器"警告（晚订阅多客户端场景）
    this.setMaxListeners(0);
    this.bufferMax = options?.bufferMax ?? DEFAULT_BUFFER_MAX;
    // 'error' 是白名单事件名，撞上 EventEmitter 内建语义（无监听者时 emit 抛异常）。
    // 挂一个常驻 no-op：保证 publish(ERROR) 永不因订阅面为空而抛；subscribe() 的
    // per-type 监听与它并存，各自独立收到事件。
    this.on(ClientAgentEventType.ERROR, () => {});
  }

  isClosed(): boolean {
    return this.closed;
  }

  publish(ev: ClientAgentEvent): void {
    if (this.closed) return;
    this.buffer.push(ev);
    this.trimBufferIfNeeded();
    this.emitEvent(ev);
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

  /**
   * 类型桥：emit<K> 对「联合事件名 + 联合事件值」只能推断到成员级，这里显式
   * 声明成员级签名（publish 是唯一写入口，subscribe 是唯一监听入口）。
   */
  private emitEvent(ev: ClientAgentEvent): boolean {
    return (this.emit as (eventName: ClientAgentEventType, event: ClientAgentEvent) => boolean)(
      ev.eventType,
      ev,
    );
  }

  /**
   * buffer 超限时丢弃最旧的一个非关键帧（每次 publish 至多丢一个，保持开销 O(n) 且
   * buffer 稳定在 bufferMax 附近）。关键帧永不丢弃。
   */
  private trimBufferIfNeeded(): void {
    if (this.buffer.length <= this.bufferMax) return;
    for (let i = 0; i < this.buffer.length; i++) {
      if (!CRITICAL_EVENT_TYPES.has(this.buffer[i].eventType)) {
        this.buffer.splice(i, 1);
        this.droppedCount += 1;
        if (this.droppedCount === 1 || this.droppedCount % 500 === 0) {
          console.warn(
            `[stream-bridge] buffer trimmed (dropped=${this.droppedCount}, max=${this.bufferMax}) ` +
              `thread=${this.threadId} run=${this.runId}`,
          );
        }
        return;
      }
    }
  }

  /**
   * 返回一个 AsyncIterable，先回放 buffer，再监听后续事件。
   *
   * 每个事件名注册一个监听（CLOSED_EVENT 额外一个）：跨类型的全局时序由单一的
   * pending 队列保持——所有类型共用一条队列，先到先出。
   */
  subscribe(): AsyncIterable<ClientAgentEvent> {
    const buffered = this.buffer.slice();
    const isClosed = () => this.closed;
    // 后续事件队列：回放完成后到达的 publish 进这里；保证不丢事件
    const pending: ClientAgentEvent[] = [];
    let resolveNext: ((v: IteratorResult<ClientAgentEvent>) => void) | null = null;

    const onEvent = (ev: ClientAgentEvent) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: ev, done: false });
      } else {
        pending.push(ev);
      }
    };
    const onClosed = () => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined, done: true });
      }
    };

    // 快照与注册监听在同一段同步代码内完成：两者之间没有让出点，publish 无法插入，
    // 因此任何事件要么在快照里（走回放）、要么经监听进 pending（走实时），不丢不重。
    for (const t of ALL_EVENT_TYPES) {
      this.on(t, onEvent);
    }
    this.on(CLOSED_EVENT, onClosed);
    const cleanup = () => {
      for (const t of ALL_EVENT_TYPES) {
        this.off(t, onEvent);
      }
      this.off(CLOSED_EVENT, onClosed);
    };

    return {
      [Symbol.asyncIterator](): AsyncIterator<ClientAgentEvent> {
        let i = 0;

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
    // 唤醒所有挂起的 next()：符号事件只作为内部信号，不会以数据帧形态
    // 到达任何订阅者（真实 END 由 executeRun finally 的 publish 保证）。
    this.emit(CLOSED_EVENT);
    this.removeAllListeners();
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
