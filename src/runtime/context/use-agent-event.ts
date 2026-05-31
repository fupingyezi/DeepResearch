'use client';

import { useContext } from 'react';

import { AgentEventContext, type AgentEventContextValue } from './agent-event-context';

/**
 * useAgentEvent
 *
 * 获取当前 AgentEventProvider 暴露的控制句柄（bus / run / abort / isRunning）。
 *
 * 必须在 `<AgentEventProvider>` 子树内调用，否则抛错。
 */
export function useAgentEvent(): AgentEventContextValue {
  const ctx = useContext(AgentEventContext);
  if (!ctx) {
    throw new Error('useAgentEvent must be used within <AgentEventProvider>');
  }
  return ctx;
}
