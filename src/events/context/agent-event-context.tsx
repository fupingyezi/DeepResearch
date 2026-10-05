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
 * - 断点续读：连接中断（未收到 END 且非用户取消）时凭最后收到的 eventId
 *   重连 stream 路由，START 不重、已收事件不重、END 至多一次
 * - 泵在 emit 前给事件贴 sessionId / streamId 两个分拣字段
 *   （RoutedClientAgentEvent，前端本地类型，不进线协议）
 * - store 写入者 SessionStreamSink 是 EventBus 的一等通配订阅者（attachSinkToBus
 *   幂等挂载，StrictMode / HMR 双挂安全）
 * - 卸载时 abort 全部泵 + 清空订阅，避免泄漏
 */

import { createContext, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { ClientAgentEventType, type SseStreamEvent } from '../protocol/client-event';
import { EventBus, createAgentEventStream, type RoutedClientAgentEvent } from '../client';
import {
  attachSinkToBus,
  finishSessionSink,
  resolveRunSessionId,
  startSessionSink,
} from '@/utils/chat/agent-event-sink';
import { buildChatRequestBody, type RunOptions } from '@/utils/chat/chat-request-body';

/** 重连最大尝试次数：全部失败后把最后一次失败帧外发（行为与无重连时一致）。 */
const RECONNECT_MAX_ATTEMPTS = 3;
/** 重连退避基数（ms）：第 n 次重试前等 n×基数。 */
const RECONNECT_BACKOFF_MS = 1000;

/** 可中断的退避等待：用户点停止时立即结束等待（abort 信号触发 resolve 而非 reject）。 */
const delayAbortable = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** 客户端自产的失败帧（fetch 失败 / HTTP 错误 / 读中断）的判定：errorCode 前缀。 */
const isClientFailureFrame = (frame: SseStreamEvent): boolean =>
  frame.event.eventType === ClientAgentEventType.ERROR &&
  frame.event.payload.errorCode.startsWith('AGENT_STREAM_');

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
      // 断点续读状态：eventId 游标随带 id 的帧前进；START 帧给出重连路由所需的
      // threadId / runId；sawEnd 标记流已收束（正常结束不再重连）
      let lastEventId: string | null = null;
      let sawEnd = false;
      let streamThreadId: string | null = null;
      let streamRunId: string | null = null;

      const emitFrame = (frame: SseStreamEvent): void => {
        if (frame.eventId) lastEventId = frame.eventId;
        if (frame.event.eventType === ClientAgentEventType.START) {
          streamThreadId = frame.event.payload.thread_id ?? frame.event.payload.sessionId ?? null;
          streamRunId = frame.event.payload.run_id ?? null;
        }
        if (frame.event.eventType === ClientAgentEventType.END) sawEnd = true;
        busRef.current?.emit({
          ...frame.event,
          sessionId,
          streamId,
        } satisfies RoutedClientAgentEvent);
      };

      const stream = createAgentEventStream({
        endpoint: '/api/v3/chat',
        method: 'POST',
        body: buildChatRequestBody({ ...opts, sessionId, isNewSession }),
        signal: controller.signal,
      });
      for await (const frame of stream) emitFrame(frame);

      // 重连：连接中断（未收到 END 且非用户取消）时凭 last-event-id 续读——
      // 服务端从游标之后重放，START 不重、已收事件不重、END 至多一次。
      // 重连失败帧不外发（避免把瞬时网络抖动当成 run 失败刷进气泡），
      // 全部尝试失败才把最后一次失败帧外发，UI 与无重连时一致。
      let lastFailure: SseStreamEvent | null = null;
      for (
        let attempt = 0;
        !sawEnd &&
        !controller.signal.aborted &&
        streamThreadId &&
        streamRunId &&
        attempt < RECONNECT_MAX_ATTEMPTS;
        attempt++
      ) {
        if (attempt > 0) await delayAbortable(attempt * RECONNECT_BACKOFF_MS, controller.signal);
        if (controller.signal.aborted) break;
        const reconnect = createAgentEventStream({
          endpoint: `/api/threads/${streamThreadId}/runs/${streamRunId}/stream${
            lastEventId ? `?last-event-id=${encodeURIComponent(lastEventId)}` : ''
          }`,
          method: 'GET',
          signal: controller.signal,
        });
        for await (const frame of reconnect) {
          if (isClientFailureFrame(frame)) {
            lastFailure = frame;
            break;
          }
          emitFrame(frame);
        }
      }
      if (lastFailure && !sawEnd && !controller.signal.aborted) {
        emitFrame(lastFailure);
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
