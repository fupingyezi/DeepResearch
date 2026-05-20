/**
 * RuntimeContext —— 通过 AsyncLocalStorage 在 lead-agent / sub-agent 调用链上
 * 透传 thread / run / user 等运行时信息（等价 Python `contextvars.ContextVar`）。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RuntimeContext {
  thread_id: string;
  run_id: string;
  assistant_id: string;
  user_id?: string;
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
