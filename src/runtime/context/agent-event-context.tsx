"use client";

/**
 * AgentEventContext / AgentEventProvider
 *
 * 通过 React Context 把 EventBus 与流控制能力（run / abort / isRunning）
 * 暴露给组件树。组件用 `useAgentEvent` 拿到控制句柄，用 `useAgentEventListener`
 * 就近订阅事件。
 *
 * 设计要点：
 * - EventBus 用 `useRef` 持有单例，Provider 生命周期内引用稳定
 * - 同一时刻只允许一次 run（重复调用会先 abort 上一次）
 * - run 内部驱动 `createAgentEventStream` 并 emit 到 bus
 * - 卸载时自动 abort 并 clear bus，避免泄漏
 */

import { createContext, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  EventBus,
  createAgentEventStream,
  type AgentEventStreamOptions,
} from "../client";

export interface AgentEventContextValue {
  /** 事件总线，用于订阅 */
  bus: EventBus;
  /** 启动一次 SSE 流式会话；若已有进行中的 run 会先 abort */
  run: (opts: AgentEventStreamOptions) => Promise<void>;
  /** 中断当前流 */
  abort: () => void;
  /** 当前是否有正在进行的流 */
  isRunning: boolean;
}

export const AgentEventContext = createContext<AgentEventContextValue | null>(
  null,
);

export interface AgentEventProviderProps {
  children: ReactNode;
}

export function AgentEventProvider({ children }: AgentEventProviderProps) {
  const busRef = useRef<EventBus | null>(null);
  if (!busRef.current) {
    busRef.current = new EventBus();
  }
  const abortRef = useRef<AbortController | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const run = useCallback(async (opts: AgentEventStreamOptions) => {
    // 若已有进行中的流，先 abort
    abortRef.current?.abort();

    const controller = new AbortController();
    abortRef.current = controller;

    // 合并外部 signal：任一触发即 abort 内部 controller
    if (opts.signal) {
      if (opts.signal.aborted) {
        controller.abort();
      } else {
        opts.signal.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
      }
    }

    setIsRunning(true);
    try {
      const stream = createAgentEventStream({
        ...opts,
        signal: controller.signal,
      });
      for await (const event of stream) {
        busRef.current?.emit(event);
      }
    } finally {
      // 仅在当前 controller 仍是最新时清理状态，避免覆盖后续 run 的状态
      if (abortRef.current === controller) {
        abortRef.current = null;
        setIsRunning(false);
      }
    }
  }, []);

  // 卸载时清理：abort in-flight + 清空订阅
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      busRef.current?.clear();
    };
  }, []);

  // value 引用稳定：bus 是 ref 单例；run/abort 是 useCallback 包裹；isRunning 变化时整体重渲染
  const value: AgentEventContextValue = {
    bus: busRef.current,
    run,
    abort,
    isRunning,
  };

  return (
    <AgentEventContext.Provider value={value}>
      {children}
    </AgentEventContext.Provider>
  );
}
