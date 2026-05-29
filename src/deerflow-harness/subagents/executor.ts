import { v4 as uuidv4 } from 'uuid';
import { HumanMessage } from '@langchain/core/messages';
import { StructuredToolInterface } from '@langchain/core/tools';

import { createBaseAgent } from '../agents/factory';
import { createChatModel, inferProvider } from '../models';
import { getContext } from '../runtime/context';
import { ModelConfig, SubagentEvent } from '../types';
import { SubagentConfig } from './config';
import { extractSubagentReport } from './schema';

export interface SubagentExecutorOptions {
  config: SubagentConfig;
  tools: StructuredToolInterface[];
  /** 可选 trace id；调用方未提供时内部生成。 */
  traceId?: string;
  /** 可选 task id（通常来自 lead agent 的 tool_call_id）；未提供时使用 traceId。 */
  taskId?: string;
  /**
   * 当 `config.model === 'inherit'` 时使用此 ModelConfig 构建 ChatModel。
   * 由 task-tool 从 RuntimeContext.currentModelConfig 读取后透传。
   * 缺省时退化为 `createChatModel({ modelName: 'inherit' })` —— 该路径
   * 通常会被 createChatModel 的 modelName 兜底解析为默认模型。
   */
  inheritedModelConfig?: ModelConfig;
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
  private readonly inheritedModelConfig?: ModelConfig;

  constructor(opts: SubagentExecutorOptions) {
    this.config = opts.config;
    this.tools = opts.tools;
    this.traceId = opts.traceId ?? uuidv4().slice(0, 8);
    this.taskId = opts.taskId ?? this.traceId;
    this.inheritedModelConfig = opts.inheritedModelConfig;
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
      //   model='inherit' → 复用 lead 当前 ModelConfig（baseUrl/apiKey/temperature 等）
      //   其它值          → 按 modelName 走默认 createChatModel（baseUrl/apiKey 取 env）
      const isInherit = config.model === 'inherit' || !config.model;
      const modelConfig: ModelConfig = isInherit
        ? this.inheritedModelConfig ?? { modelName: 'inherit' }
        : { modelName: config.model };
      if (isInherit && !this.inheritedModelConfig && process.env.NODE_ENV !== 'production') {
        console.warn(
          `${logPrefix} model='inherit' but no inheritedModelConfig provided; ` +
            `falling back to createChatModel default (modelName="inherit").`,
        );
      }
      const model = createChatModel(modelConfig);
      const provider = inferProvider(modelConfig);
      const agent: any = createBaseAgent({
        model,
        tools: this.tools,
        systemPrompt: config.systemPrompt,
        provider,
      });

      // 5) 主循环：消费 LangGraph stream
      const input = { messages: [new HumanMessage(prompt)] };
      // 若处于 thread 上下文中，把 thread_id 透传给子图，让父子共用同一 checkpoint thread
      const ctxThreadId = getContext()?.thread_id;
      const streamOpts: Record<string, any> = {
        signal: internalCtl.signal,
        // 增加 'updates' 用于补抓 ToolMessage（subagent 内部工具结果）
        streamMode: ['messages', 'updates'],
        recursionLimit: Math.max(2, config.maxTurns) * 2,
      };
      if (ctxThreadId) {
        streamOpts.configurable = { thread_id: ctxThreadId };
      }
      const stream = await agent.stream(input, streamOpts);

      let aiMessageCount = 0;
      // 累计完整文本，用于在终态尝试 schema 解析
      let aggregatedFinalText = '';

      // tool_call 分片累积器（与 lead 流处理逻辑对齐）：
      // 子模型按 OpenAI 协议把 args 分片下发，需要按 index 累加后再 emit。
      type ToolCallAcc = {
        toolCallId: string;
        toolName: string;
        argsBuffer: string;
        startEmitted: boolean;
      };
      const toolCallsByIndex = new Map<number, ToolCallAcc>();
      const toolCallsById = new Map<string, ToolCallAcc>();

      const emitToolCallStart = (acc: ToolCallAcc): SubagentEvent | null => {
        if (acc.startEmitted || !acc.toolCallId || !acc.toolName) return null;
        acc.startEmitted = true;
        return {
          kind: 'tool_call',
          taskId,
          toolCallId: acc.toolCallId,
          toolName: acc.toolName,
          arguments: acc.argsBuffer || '{}',
        };
      };

      for await (const chunk of stream) {
        const [mode, payload] = chunk as [string, any];

        if (mode === 'messages') {
          // payload 形如 [msgChunk, metadata]
          const msgChunk = Array.isArray(payload) ? payload[0] : undefined;
          if (!msgChunk) continue;
          const msgType = (msgChunk as any)?._getType?.() ?? (msgChunk as any)?.type;
          if (msgType !== 'ai') continue;

          // 5.a) 累积 tool_call 分片
          const tcChunks = (msgChunk as any).tool_call_chunks as
            | Array<{ index?: number; id?: string; name?: string; args?: string }>
            | undefined;
          if (Array.isArray(tcChunks) && tcChunks.length > 0) {
            for (const piece of tcChunks) {
              const idx = piece.index ?? 0;
              let acc = toolCallsByIndex.get(idx);
              if (!acc) {
                acc = {
                  toolCallId: '',
                  toolName: '',
                  argsBuffer: '',
                  startEmitted: false,
                };
                toolCallsByIndex.set(idx, acc);
              }
              if (piece.id) {
                acc.toolCallId = piece.id;
                toolCallsById.set(piece.id, acc);
              }
              if (piece.name) acc.toolName = piece.name;
              if (typeof piece.args === 'string') acc.argsBuffer += piece.args;
            }
            // 工具调用分片进行中：跳过本帧，等 LangGraph 推完整 AIMessage 时再发
            continue;
          }

          // 5.b) 完整 AI 消息（可能含 tool_calls 或文本）
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

          // 5.c) 拿到完整 tool_calls 时，把每个累计完成的 acc 作为 tool_call 事件 emit
          if (hasFinalToolCalls) {
            for (const tc of toolCalls as Array<{ id?: string; name?: string; args?: any }>) {
              if (!tc?.id) continue;
              let acc = toolCallsById.get(tc.id);
              if (!acc) {
                // 罕见：直接非分片下发；现场构造一个 acc
                acc = {
                  toolCallId: tc.id,
                  toolName: tc.name ?? '',
                  argsBuffer:
                    typeof tc.args === 'string'
                      ? tc.args
                      : tc.args
                      ? safeJsonStringify(tc.args)
                      : '',
                  startEmitted: false,
                };
                toolCallsById.set(tc.id, acc);
              } else {
                if (!acc.toolName && tc.name) acc.toolName = tc.name;
                if (!acc.argsBuffer && tc.args) {
                  acc.argsBuffer =
                    typeof tc.args === 'string' ? tc.args : safeJsonStringify(tc.args);
                }
              }
              const ev = emitToolCallStart(acc);
              if (ev) yield ev;
            }
          }

          // 5.d) 文本分类：含 tool_calls → reasoning（planning），否则 → 正文（最终答案）
          const contentStr = typeof content === 'string' && content.trim() ? content : '';
          // deerflow 2.0 原则：含 tool_calls 的 AI message 的 content 是"思考/规划"
          if (contentStr && !hasFinalToolCalls) {
            aggregatedFinalText += contentStr;
          }
          aiMessageCount += 1;
          yield {
            kind: 'ai_message',
            taskId,
            message: slimSerializeMessage(msgChunk),
            index: aiMessageCount,
            total: aiMessageCount,
            reasoning: hasFinalToolCalls && contentStr ? contentStr : undefined,
          };
          continue;
        }

        // 5.e) updates 分支：补抓 ToolMessage，发出 tool_result 事件
        if (mode !== 'updates' || !payload || typeof payload !== 'object') continue;
        for (const nodeName of Object.keys(payload)) {
          const msgs = payload[nodeName]?.messages;
          if (!Array.isArray(msgs)) continue;
          for (const msg of msgs) {
            const t = (msg as any)?._getType?.();
            if (t !== 'tool') continue;
            const toolCallId: string = (msg as any).tool_call_id ?? '';
            const acc = toolCallsById.get(toolCallId);
            // 兜底：如果还没 emit 过 tool_call_start，就先补一次
            if (acc) {
              const startEvt = emitToolCallStart(acc);
              if (startEvt) yield startEvt;
            }
            const toolName = (msg as any).name ?? acc?.toolName ?? '';
            const status = (msg as any).status; // 'error' / undefined
            yield {
              kind: 'tool_result',
              taskId,
              toolCallId,
              toolName,
              result: (msg as any).content,
              success: status !== 'error',
              errorMessage: status === 'error' ? String((msg as any).content ?? '') : undefined,
            };
          }
        }
      }

      // 6) 终态：completed -------------------------------------------------
      // 尝试从最终输出中提取 schema 化的 final-report 块
      const { json: structured, markdown } = extractSubagentReport(aggregatedFinalText);
      const resultText = aggregatedFinalText.length > 0 ? markdown : null;
      yield {
        kind: 'completed',
        taskId,
        result: resultText,
        structured: structured ?? null,
      };
      console.info(
        `${logPrefix} completed (messages=${aiMessageCount}, structured=${
          structured ? 'yes' : 'no'
        })`,
      );
    } catch (err: any) {
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
 * 序列化 LangChain message chunk 为体积可控的 plain object。
 *
 * 历史版本会把整个 message（含原始 tool_call_chunks、additional_kwargs）
 * 全部 dump，导致单帧体积 100KB+，前端 SSE 解析卡顿、表现像"已完成还在转"。
 * 新版只保留前端真正需要的：text + tool_calls 摘要。
 */
function slimSerializeMessage(msg: any): Record<string, any> {
  if (!msg || typeof msg !== 'object') return { type: 'unknown', text: String(msg ?? '') };
  const text =
    typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
      ? msg.content
          .map((c: any) => (typeof c === 'string' ? c : c?.text ?? ''))
          .join('')
      : '';
  const toolCalls = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((tc: any) => ({
        id: tc?.id,
        name: tc?.name,
        argKeys:
          tc?.args && typeof tc.args === 'object'
            ? Object.keys(tc.args).slice(0, 8)
            : undefined,
      }))
    : undefined;
  return {
    type: msg?._getType?.() ?? msg.type ?? 'ai',
    text,
    toolCalls,
  };
}

function safeJsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}
