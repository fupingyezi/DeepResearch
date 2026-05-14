'use client';

import { useEffect, useRef } from 'react';

import type { ClientAgentEvent, ClientAgentEventType } from '../protocol/client-event';
import { useAgentEvent } from './use-agent-event';

/**
 * 通配订阅签名：handler 接收所有事件
 */
type WildcardHandler = (event: ClientAgentEvent) => void;

/**
 * 类型化订阅签名：handler 仅接收对应 eventType 的事件，payload 自动收窄
 */
type TypedHandler<T extends ClientAgentEventType> = (
  event: Extract<ClientAgentEvent, { eventType: T }>,
) => void;

/**
 * useAgentEventListener
 *
 * 在组件挂载时订阅 EventBus，卸载时自动取消。
 *
 * 通过 latest-ref 模式缓存最新 handler，确保 useEffect 仅依赖 [type, bus]，
 * 组件 re-render 时不会触发 EventBus 重订阅。
 *
 * @example
 * ```tsx
 * useAgentEventListener(ClientAgentEventType.STREAM_CHUNK, (event) => {
 *   // event.payload 自动收窄为 StreamChunkPayload
 *   appendText(event.payload.text);
 * });
 *
 * // 通配订阅
 * useAgentEventListener("*", (event) => {
 *   console.log(event.eventType);
 * });
 * ```
 */
export function useAgentEventListener(type: '*', handler: WildcardHandler): void;

export function useAgentEventListener<T extends ClientAgentEventType>(
  type: T,
  handler: TypedHandler<T>,
): void;

export function useAgentEventListener(
  type: ClientAgentEventType | '*',
  handler: (event: ClientAgentEvent) => void,
): void {
  const { bus } = useAgentEvent();
  const handlerRef = useRef(handler);

  // 每次 render 都更新 latest handler，但订阅函数引用恒定
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    const unsubscribe = bus.on(type, (event) => handlerRef.current(event));
    return unsubscribe;
  }, [type, bus]);
}
