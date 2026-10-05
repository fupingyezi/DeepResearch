/**
 * EventBus —— 官方 EventEmitter 的前端薄包装
 *
 * 官方 `events` 包（浏览器 bundle 走 Next 内置 polyfill，仅用同步 API）作为核心
 * 注册表：on/off/once/emit 全部落到 EventEmitter 上。本层只补三样官方没有的语义：
 *
 * - 通配符 `"*"` 订阅所有事件
 * - 单个 handler 抛错被 try/catch 隔离，不影响其他订阅者
 *   （EventEmitter 默认把 handler 异常同步冒泡给 emit 调用者）
 * - `on(type, handler)` 返回 unsubscribe 函数（与 React `useEffect` cleanup 对齐）
 *
 * 事件载荷是 `RoutedClientAgentEvent`：泵在 emit 前补上 sessionId / streamId 两个
 * 多会话分拣字段（前端本地类型，不进 SSE 线协议）。
 */

import { EventEmitter } from 'events';

import { ClientAgentEventType, type ClientAgentEvent } from '../protocol/client-event';

/**
 * 前端泵注入的本地路由事件：sessionId / streamId 是泵在 emit 前补上的多会话分拣
 * 字段。线协议（`client-event.ts` 的 10 种冻结事件）保持零改动。
 */
export type RoutedClientAgentEvent = ClientAgentEvent & {
  sessionId: string;
  streamId: number;
};

export type AgentEventHandler = (event: RoutedClientAgentEvent) => void;

export type EventBusKey = ClientAgentEventType | '*';

export class EventBus {
  private readonly emitter = new EventEmitter();
  /** type → 原始 handler → 包了 try/catch 的 safe handler（off 按原始引用反查） */
  private readonly wrapped = new Map<string, Map<AgentEventHandler, AgentEventHandler>>();

  constructor() {
    // 订阅面不设上限（与旧 Map 实现一致）
    this.emitter.setMaxListeners(0);
    // 'error' 是白名单事件名，撞 EventEmitter 内建语义（无监听者时 emit 抛异常）。
    // 常驻 no-op 保证「只有通配订阅者」时派发 ERROR 也不抛。
    // （与后端 ThreadChannel 同一招，前后端对称）
    this.emitter.on(ClientAgentEventType.ERROR, () => {});
  }

  /**
   * 订阅指定类型事件。返回 unsubscribe 函数。
   */
  on(type: EventBusKey, handler: AgentEventHandler): () => void {
    this.emitter.on(type, this.ensureSafe(type, handler));
    return () => this.off(type, handler);
  }

  /** 取消订阅 */
  off(type: EventBusKey, handler: AgentEventHandler): void {
    const safe = this.wrapped.get(type)?.get(handler);
    if (!safe) return;
    this.emitter.off(type, safe);
    this.wrapped.get(type)?.delete(handler);
  }

  /** 一次性订阅，触发后自动取消 */
  once(type: EventBusKey, handler: AgentEventHandler): () => void {
    const safe: AgentEventHandler = (event) => {
      // once 触发即自动反注册：先清 wrapped 映射，再跑 handler
      this.wrapped.get(type)?.delete(handler);
      this.runGuarded(handler, event);
    };
    this.ensureWrapped(type, handler, safe);
    this.emitter.once(type, safe);
    return () => this.off(type, handler);
  }

  /**
   * 派发事件：先触发同类型订阅者，再触发通配 `*` 订阅者。
   * 单个 handler 抛错不影响其他订阅者。
   */
  emit(event: RoutedClientAgentEvent): void {
    // EventEmitter 内部 emit 先拷贝监听器快照再调用，派发期间的订阅变更
    // 不影响本轮（与旧实现 `[...set]` 语义等价）。
    this.emitter.emit(event.eventType, event);
    this.emitter.emit('*', event);
  }

  /** 清空所有订阅 */
  clear(): void {
    this.emitter.removeAllListeners();
    this.wrapped.clear();
    // 重建 'error' no-op：removeAllListeners 会摘掉它
    this.emitter.on(ClientAgentEventType.ERROR, () => {});
  }

  /** 取（或建）handler 的 safe 包装：同 type 同 handler 只包一次，off 反查同一引用。 */
  private ensureSafe(type: EventBusKey, handler: AgentEventHandler): AgentEventHandler {
    const safe = this.wrapped.get(type)?.get(handler);
    if (safe) return safe;
    const wrapped = (event: RoutedClientAgentEvent) => this.runGuarded(handler, event);
    this.ensureWrapped(type, handler, wrapped);
    return wrapped;
  }

  private ensureWrapped(
    type: EventBusKey,
    handler: AgentEventHandler,
    safe: AgentEventHandler,
  ): void {
    let byType = this.wrapped.get(type);
    if (!byType) {
      byType = new Map();
      this.wrapped.set(type, byType);
    }
    byType.set(handler, safe);
  }

  /** 异常隔离：单个 handler 抛错只记日志，不影响其他订阅者与 emit 调用方。 */
  private runGuarded(handler: AgentEventHandler, event: RoutedClientAgentEvent): void {
    try {
      handler(event);
    } catch (err) {
      console.error(`[EventBus] handler error for ${event.eventType}:`, err);
    }
  }
}
