/**
 * EventBus
 *
 * 轻量 pub/sub，用于在 `AgentEventProvider` 内部分发 ClientAgentEvent 到组件。
 *
 * - `on(type, handler)` 返回 unsubscribe 函数（与 React `useEffect` cleanup 对齐）
 * - 通配符 `"*"` 订阅所有事件
 * - 单个 handler 抛错被 try/catch 隔离，不影响其他订阅者
 */

import type { ClientAgentEvent, ClientAgentEventType } from '../protocol/client-event';

export type AgentEventHandler = (event: ClientAgentEvent) => void;

export type EventBusKey = ClientAgentEventType | '*';

export class EventBus {
  private readonly handlers = new Map<string, Set<AgentEventHandler>>();

  /**
   * 订阅指定类型事件。返回 unsubscribe 函数。
   */
  on(type: EventBusKey, handler: AgentEventHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => this.off(type, handler);
  }

  /** 取消订阅 */
  off(type: EventBusKey, handler: AgentEventHandler): void {
    const set = this.handlers.get(type);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.handlers.delete(type);
  }

  /** 一次性订阅，触发后自动取消 */
  once(type: EventBusKey, handler: AgentEventHandler): () => void {
    const wrapped: AgentEventHandler = (event) => {
      this.off(type, wrapped);
      handler(event);
    };
    return this.on(type, wrapped);
  }

  /**
   * 派发事件：先触发同类型订阅者，再触发通配 `*` 订阅者。
   * 单个 handler 抛错不影响其他订阅者。
   */
  emit(event: ClientAgentEvent): void {
    this.dispatch(event.eventType, event);
    this.dispatch('*', event);
  }

  /** 清空所有订阅 */
  clear(): void {
    this.handlers.clear();
  }

  private dispatch(key: string, event: ClientAgentEvent): void {
    const set = this.handlers.get(key);
    if (!set || set.size === 0) return;
    // 拷贝快照，避免在迭代过程中订阅者修改 set 导致行为不可预期
    for (const handler of [...set]) {
      try {
        handler(event);
      } catch (err) {
        console.error(`[EventBus] handler error for ${event.eventType}:`, err);
      }
    }
  }
}
