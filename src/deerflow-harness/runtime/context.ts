/**
 * RuntimeContext —— 通过 AsyncLocalStorage 在 lead-agent / sub-agent 调用链上
 * 透传 thread / run / user 等运行时信息。
 *
 * 字段说明：
 * - `currentModelConfig`：lead-agent 当前轮次使用的 ModelConfig。
 *   `general-purpose` subagent 的 `model: 'inherit'` 通过该字段拿到 lead 的
 *   modelConfig，保证 lead/subagent 走同一模型与 baseUrl/apiKey。
 *   由 `DeerFlowClient.stream()` 在 `runWithContext` 入口注入。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModelConfig } from '../types';

export interface RuntimeContext {
  thread_id: string;
  run_id: string;
  assistant_id: string;
  user_id?: string;
  /**
   * memory 作用域的 agent 名称，供 `memoryMiddleware.afterAgent` 在异步落盘时
   * 决定记忆文件路径。
   *
   * lead「用户对话」**不写入**该字段（保持 undefined → 解析为 null），使读/写/注入
   * 三侧统一落在「跨 agent 全局 per-user」记忆 `users/{userId}/memory.json`，
   */
  agent_name?: string;
  /** lead-agent 当前轮次的 ModelConfig，供 inherit 模式下的 subagent 复用。 */
  currentModelConfig?: ModelConfig;
}

const als = new AsyncLocalStorage<RuntimeContext>();

export function runWithContext<T>(ctx: RuntimeContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

export function getContext(): RuntimeContext | undefined {
  return als.getStore();
}

export function requireContext(): RuntimeContext {
  const c = als.getStore();
  if (!c) throw new Error('[runtime/context] runtime context is not set');
  return c;
}
