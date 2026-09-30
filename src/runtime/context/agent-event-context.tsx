'use client';

/**
 * AgentEventContext / AgentEventProvider
 *
 * 通过 React Context 把 EventBus 与流控制能力（run / abort / runningSessionIds）
 * 暴露给组件树。组件用 `useAgentEvent` 拿到控制句柄，用 `useAgentEventListener`
 * 就近订阅事件。
 *
 * 设计要点：
 * - EventBus 用 `useRef` 持有单例，Provider 生命周期内引用稳定
 * - 泵化：每个 session 一个泵（fetch + 分帧 + emit），多会话互不干扰；
 *   同 session 重跑先 abort 旧泵（supersede，对齐后端抢占语义）
 * - 泵在 emit 前给事件贴 sessionId / streamId 两个分拣字段
 *   （RoutedClientAgentEvent，前端本地类型，不进线协议）
 * - store 写入者 SessionStreamSink 是 EventBus 的一等通配订阅者（attachSinkToBus
 *   幂等挂载，StrictMode / HMR 双挂安全）
 * - 卸载时 abort 全部泵 + 清空订阅，避免泄漏
 */

import { createContext, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { EventBus, createAgentEventStream, type RoutedClientAgentEvent } from '../client';
import {
  attachSinkToBus,
  finishSessionSink,
  resolveRunSessionId,
  startSessionSink,
} from '@/utils/chat/agent-event-sink';
import { buildChatRequestBody, type RunOptions } from '@/utils/chat/chat-request-body';

export interface AgentEventContextValue {
  /** 事件总线，用于订阅 */
  bus: EventBus;
  /** 为指定会话启动一次 SSE 流式会话；同 session 重跑会先 abort 旧泵 */
  run: (opts: RunOptions) => Promise<void>;
  /** 中止指定会话的泵 */
  abort: (sessionId: string) => void;
  /** 正在跑 run 的会话集合（多会话并行） */
  runningSessionIds: ReadonlySet<string>;
}

export const AgentEventContext = createContext<AgentEventContextValue | null>(null);

export interface AgentEventProviderProps {
  children: ReactNode;
}

export function AgentEventProvider({ children }: AgentEventProviderProps) {
  const busRef = useRef<EventBus | null>(null);
  if (!busRef.current) {
    busRef.current = new EventBus();
  }
  const pumpsRef = useRef(new Map<string, AbortController>());
  const streamSeqRef = useRef(0);
  const [runningSessionIds, setRunningSessionIds] = useState<ReadonlySet<string>>(new Set());

  // sink 挂载（store 写入者是一等订阅者）。attach 幂等，effect cleanup 时 detach。
  useEffect(() => {
    return attachSinkToBus(busRef.current as EventBus);
  }, []);

  const abort = useCallback((sessionId: string) => {
    pumpsRef.current.get(sessionId)?.abort();
  }, []);

  const run = useCallback(async (opts: RunOptions) => {
    const { sessionId, isNewSession } = resolveRunSessionId(opts);

    // 同 session 重跑：先 abort 旧泵（supersede）。旧泵的迟到事件被 streamId 防串
    // 丢弃；其取消标记由服务端落库侧 waitRunError 兜底。
    pumpsRef.current.get(sessionId)?.abort();
    const controller = new AbortController();
    pumpsRef.current.set(sessionId, controller);

    // 合并外部 signal：任一触发即 abort 内部 controller
    if (opts.signal) {
      if (opts.signal.aborted) {
        controller.abort();
      } else {
        opts.signal.addEventListener('abort', () => controller.abort(), {
          once: true,
        });
      }
    }

    const streamId = ++streamSeqRef.current;
    const started = startSessionSink({
      ...opts,
      sessionId,
      isNewSession,
      streamId,
      controller,
    });
    if (!started) {
      // 空输入早退（对齐旧 handler execute() 守卫）：不发请求
      pumpsRef.current.delete(sessionId);
      return;
    }
    setRunningSessionIds((prev) => new Set(prev).add(sessionId));

    try {
      const stream = createAgentEventStream({
        endpoint: '/api/v3/chat',
        method: 'POST',
        body: buildChatRequestBody({ ...opts, sessionId, isNewSession }),
        signal: controller.signal,
      });
      for await (const event of stream) {
        busRef.current?.emit({
          ...event,
          sessionId,
          streamId,
        } satisfies RoutedClientAgentEvent);
      }
    } finally {
      // 仅在当前 controller 仍是最新时清理泵表，避免覆盖后续 run 的注册
      if (pumpsRef.current.get(sessionId) === controller) {
        pumpsRef.current.delete(sessionId);
      }
      finishSessionSink(sessionId, streamId);
      setRunningSessionIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  }, []);

  // 卸载时清理：abort 全部 in-flight 泵 + 清空订阅。
  // pumps Map 实例全程不变（只 set/delete 不换引用），effect 内捕获与 cleanup 时读取等价。
  useEffect(() => {
    const pumps = pumpsRef.current;
    return () => {
      for (const controller of pumps.values()) controller.abort();
      pumps.clear();
      busRef.current?.clear();
    };
  }, []);

  // value 引用稳定：bus 是 ref 单例；run/abort 是 useCallback 包裹；runningSessionIds 变化时整体重渲染
  const value: AgentEventContextValue = {
    bus: busRef.current,
    run,
    abort,
    runningSessionIds,
  };

  return <AgentEventContext.Provider value={value}>{children}</AgentEventContext.Provider>;
}
