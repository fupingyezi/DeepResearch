import { randomUUID } from 'node:crypto';
import { HumanMessage } from '@langchain/core/messages';
import { StructuredToolInterface } from '@langchain/core/tools';

import { createBaseAgent } from '../agents/factory';
import { createChatModel, inferProvider } from '../models';
import { SubagentEvent } from '../types';
import { SubagentConfig } from './config';

export interface SubagentExecutorOptions {
  config: SubagentConfig;
  tools: StructuredToolInterface[];
  /** 可选 trace id；调用方未提供时内部生成。 */
  traceId?: string;
  /** 可选 task id（通常来自 lead agent 的 tool_call_id）；未提供时使用 traceId。 */
  taskId?: string;
}

/**
 * SubagentExecutor
 *
 * 单个 subagent 的执行器。`execute(prompt, parentSignal)` 返回一个
 * `AsyncIterable<SubagentEvent>`，由 task-tool 用 `for await` 消费。
 *
 * 关键不变量：
 * - 不维护任何全局/类外状态（无后台 Map、无轮询）。
 * - 终态事件（completed/failed/timed_out/cancelled）至多被 yield 一次。
 * - 资源（timer / signal listener）一律在 finally 中清理。
 */
export class SubagentExecutor {
  private readonly config: SubagentConfig;
  private readonly tools: StructuredToolInterface[];
  private readonly traceId: string;
  private readonly taskId: string;

  constructor(opts: SubagentExecutorOptions) {
    this.config = opts.config;
    this.tools = opts.tools;
    this.traceId = opts.traceId ?? randomUUID().slice(0, 8);
    this.taskId = opts.taskId ?? this.traceId;
  }

  async *execute(
    prompt: string,
    parentSignal?: AbortSignal,
  ): AsyncGenerator<SubagentEvent, void, void> {
    const { config, traceId, taskId } = this;
    const logPrefix = `[trace=${traceId}] [subagent=${config.name}]`;

    // 1) 组合 AbortSignal：父 signal + 内部 timeout signal
    const internalCtl = new AbortController();
    const onParentAbort = () => internalCtl.abort(parentSignal?.reason);
    if (parentSignal?.aborted) {
      internalCtl.abort(parentSignal.reason);
    } else {
      parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    }

    // 2) 超时定时器（config.timeout 单位：秒）
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        internalCtl.abort(new Error(`Subagent timed out after ${config.timeout}s`));
      },
      Math.max(1, config.timeout) * 1000,
    );

    // 3) 启动事件
    yield { kind: 'started', taskId, description: config.description, subagentType: config.name };

    try {
      // 4) 模型 + agent 构造（每次执行独立实例）
      const model = createChatModel({ modelName: config.model });
      const provider = inferProvider({ modelName: config.model });
      const agent: any = createBaseAgent({
        model,
        tools: this.tools,
        systemPrompt: config.systemPrompt,
        provider,
      });

      // 5) 主循环：消费 LangGraph stream
      const input = { messages: [new HumanMessage(prompt)] };
      const stream = await agent.stream(input, {
        signal: internalCtl.signal,
        streamMode: ['messages', 'updates'],
        recursionLimit: Math.max(2, config.maxTurns) * 2,
      });

      let aiMessageCount = 0;
      let finalText: string | null = null;

      for await (const chunk of stream) {
        const [mode, payload] = chunk as [string, unknown];

        if (mode === 'messages') {
          // payload 形如 [msgChunk, metadata]
          const msgChunk = Array.isArray(payload) ? payload[0] : undefined;
          if (!msgChunk) continue;
          const msgType = (msgChunk as any)?._getType?.() ?? (msgChunk as any)?.type;
          if (msgType !== 'ai') continue;

          // 过滤"空心跳" AIMessageChunk
          const tcChunks = (msgChunk as any).tool_call_chunks;
          const hasToolCallChunks = Array.isArray(tcChunks) && tcChunks.length > 0;
          // 工具调用分片进行中：跳过，等 LangGraph 推完整 AIMessage 时再发
          if (hasToolCallChunks) continue;

          const content = (msgChunk as any).content;
          const hasText =
            (typeof content === 'string' && content.trim().length > 0) ||
            (Array.isArray(content) && content.length > 0);
          const toolCalls = (msgChunk as any).tool_calls;
          const hasFinalToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;

          if (!hasText && !hasFinalToolCalls) {
            // 纯空心跳：忽略
            continue;
          }

          if (typeof content === 'string' && content.trim()) {
            finalText = content;
          }
          aiMessageCount += 1;
          yield {
            kind: 'ai_message',
            taskId,
            // 序列化为 plain object，避免下游持有 LC 类实例
            message: safeSerializeMessage(msgChunk),
            index: aiMessageCount,
            total: aiMessageCount,
          };
          continue;
        }

        if (mode !== 'updates' || !payload || typeof payload !== 'object') continue;
        // updates 分支主要用于补抓最终消息；此处不再额外 yield，避免重复。
      }

      // 6) 终态：completed -------------------------------------------------
      yield { kind: 'completed', taskId, result: finalText };
      console.info(`${logPrefix} completed (messages=${aiMessageCount})`);
    } catch (err: unknown) {
      const aborted = internalCtl.signal.aborted || parentSignal?.aborted;

      if (timedOut) {
        const msg = (err as Error)?.message ?? 'Subagent timed out';
        yield { kind: 'timed_out', taskId, error: msg };
        console.warn(`${logPrefix} timed out: ${msg}`);
        return;
      }

      if (aborted) {
        const reason = parentSignal?.reason ?? (err as Error)?.message ?? 'cancelled';
        const reasonStr = reason instanceof Error ? reason.message : String(reason ?? 'cancelled');
        yield { kind: 'cancelled', taskId, error: reasonStr };
        console.info(`${logPrefix} cancelled: ${reasonStr}`);
        return;
      }

      const msg = err instanceof Error ? err.message : String(err);
      yield { kind: 'failed', taskId, error: msg };
      console.error(`${logPrefix} failed:`, err);
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    }
  }
}

/**
 * 把 LangChain message chunk 转成可安全序列化的对象，避免 writer/SSE 链路
 * 持有完整类实例（含循环引用风险）。
 */
function safeSerializeMessage(msg: unknown): Record<string, unknown> {
  if (!msg || typeof msg !== 'object') return { content: String(msg ?? '') };
  const m = msg as Record<string, unknown>;
  return {
    type: (m as any)?._getType?.() ?? m.type ?? 'unknown',
    content: m.content ?? '',
    tool_calls: (m as any).tool_calls ?? undefined,
    name: m.name ?? undefined,
    additional_kwargs: m.additional_kwargs ?? undefined,
  };
}
