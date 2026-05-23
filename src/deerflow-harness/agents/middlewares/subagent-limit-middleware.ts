import { createMiddleware } from 'langchain';
import { ToolMessage } from '@langchain/core/messages';

/**
 * SubagentLimitMiddleware（位序 11 / features.subagent 启用）
 *
 * 限制 lead-agent 通过 `task` 工具调度 subagent 的频次，防止 LLM
 * 在 plan-mode 下因 prompt 失控而无限拆分子任务。
 *
 * 双闸：
 *   - maxConcurrent：单线程内"同时进行中"的 task 数量（默认 3）
 *   - maxTotal：单线程内**累计**调度的 task 数量上限（默认 8）
 *
 * 触发后：
 *   - 不调用底层工具 handler；直接返回一条 status='error' 的 ToolMessage，
 *     提示模型不要再发起新 task；继续回包当前已收集的证据并按 plan 收尾。
 *
 * 计数维度：按 LangGraph runtime.configurable.thread_id；缺省为 'default'。
 */

export interface SubagentLimitOptions {
  /** 单线程同时 in-flight task 上限，默认 3。 */
  maxConcurrent?: number;
  /** 单线程累计 task 上限，默认 8。 */
  maxTotal?: number;
  /** LRU 阈值，超过则 evict 最旧 thread 的计数器。 */
  maxTrackedThreads?: number;
}

interface ThreadCounter {
  total: number;
  inflight: number;
}

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_MAX_TOTAL = 8;
const DEFAULT_MAX_TRACKED_THREADS = 100;

const TASK_TOOL_NAME = 'task';

function getThreadId(runtime: any): string {
  const tid = runtime?.configurable?.thread_id ?? runtime?.config?.configurable?.thread_id;
  return typeof tid === 'string' && tid ? tid : 'default';
}

class CounterRegistry {
  private readonly threads = new Map<string, ThreadCounter>();
  constructor(private readonly maxTracked: number) {}

  touch(threadId: string): ThreadCounter {
    const existing = this.threads.get(threadId);
    if (existing) {
      // LRU: 重新插入到末尾
      this.threads.delete(threadId);
      this.threads.set(threadId, existing);
      return existing;
    }
    const fresh: ThreadCounter = { total: 0, inflight: 0 };
    this.threads.set(threadId, fresh);
    while (this.threads.size > this.maxTracked) {
      const oldest = this.threads.keys().next().value;
      if (oldest === undefined) break;
      this.threads.delete(oldest);
    }
    return fresh;
  }

  reset(threadId?: string): void {
    if (threadId) this.threads.delete(threadId);
    else this.threads.clear();
  }
}

export function createSubagentLimitMiddleware(opts: SubagentLimitOptions = {}) {
  const maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const maxTotal = opts.maxTotal ?? DEFAULT_MAX_TOTAL;
  const maxTracked = opts.maxTrackedThreads ?? DEFAULT_MAX_TRACKED_THREADS;
  const registry = new CounterRegistry(maxTracked);

  const middleware = createMiddleware({
    name: 'SubagentLimitMiddleware',

    wrapToolCall: async (request, handler) => {
      const toolName = String(request.toolCall.name ?? '');
      if (toolName !== TASK_TOOL_NAME) {
        // 仅拦截 task 工具，其它工具放行
        return handler(request);
      }

      const threadId = getThreadId(request.runtime ?? request);
      const counter = registry.touch(threadId);

      if (counter.total >= maxTotal) {
        const msg =
          `[SubagentLimitMiddleware] task total cap reached (${counter.total}/${maxTotal}) ` +
          `on thread=${threadId}; rejecting new dispatch.`;
        console.warn(msg);
        return new ToolMessage({
          content:
            `Error: subagent task total limit (${maxTotal}) reached. ` +
            `Stop dispatching new tasks; collect what you have and call emit_report.`,
          tool_call_id: String(request.toolCall.id ?? ''),
          name: TASK_TOOL_NAME,
          status: 'error',
        });
      }

      if (counter.inflight >= maxConcurrent) {
        const msg =
          `[SubagentLimitMiddleware] task concurrency cap reached (${counter.inflight}/${maxConcurrent}) ` +
          `on thread=${threadId}; rejecting new dispatch.`;
        console.warn(msg);
        return new ToolMessage({
          content:
            `Error: subagent task concurrency limit (${maxConcurrent}) reached. ` +
            `Wait for an in-flight task to finish before dispatching another.`,
          tool_call_id: String(request.toolCall.id ?? ''),
          name: TASK_TOOL_NAME,
          status: 'error',
        });
      }

      counter.total += 1;
      counter.inflight += 1;
      try {
        return await handler(request);
      } finally {
        counter.inflight = Math.max(0, counter.inflight - 1);
      }
    },
  });

  return Object.assign(middleware, {
    reset: (threadId?: string) => registry.reset(threadId),
  });
}

/** 默认实例（启用时由 factory 按 features.subagent 决定是否挂载）。 */
export const subagentLimitMiddleware = createSubagentLimitMiddleware();
