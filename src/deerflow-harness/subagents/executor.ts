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
  inheritedModelConfig?: ModelConfig;
}

interface RawMessageChunk {
  _getType?: () => string;
  type?: string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; name?: string; args?: unknown }>;
  tool_call_chunks?: Array<{ index?: number; id?: string; name?: string; args?: string }>;
  tool_call_id?: string;
  name?: string;
  status?: string;
}

// tool_call 分片累积器（与 lead 流处理逻辑对齐）：
// 子模型按 OpenAI 协议把 args 分片下发，需要按 index 累加后再 emit。
interface ToolCallAcc {
  toolCallId: string;
  toolName: string;
  argsBuffer: string;
  startEmitted: boolean;
}

const toRawMessage = (msg: unknown): RawMessageChunk =>
  (msg && typeof msg === 'object' ? msg : {}) as RawMessageChunk;

/**
 * ToolCallTracker
 *
 * 负责按 OpenAI 流式协议累积 tool_call 分片：
 * - 分片帧（tool_call_chunks）按 `index` 累加 `id` / `name` / `args` 字符串
 * - 完整 AIMessage 帧（tool_calls）补齐缺失字段、构造未在分片中出现过的 acc
 * - emit `tool_call` 事件时通过 `tryMarkStart` 保证幂等
 */
class ToolCallTracker {
  // 按 OpenAI streaming 协议的 `index` 槽位号索引：同一帧并行多个 tool_call 时区分槽位。
  private readonly accsByChunkIndex = new Map<number, ToolCallAcc>();
  // 按 tool_call_id 索引：用于 updates 流（ToolMessage.tool_call_id）回查对应累加器。
  private readonly accsByToolCallId = new Map<string, ToolCallAcc>();

  /** 吸收一帧 tool_call_chunks。返回是否产生了状态更新（外层据此决定是否跳过本帧）。 */
  ingestChunks(tcChunks: RawMessageChunk['tool_call_chunks']): boolean {
    if (!Array.isArray(tcChunks) || tcChunks.length === 0) return false;
    for (const piece of tcChunks) {
      const slot = piece.index ?? 0;
      let acc = this.accsByChunkIndex.get(slot);
      if (!acc) {
        acc = { toolCallId: '', toolName: '', argsBuffer: '', startEmitted: false };
        this.accsByChunkIndex.set(slot, acc);
      }
      if (piece.id) {
        acc.toolCallId = piece.id;
        this.accsByToolCallId.set(piece.id, acc);
      }
      if (piece.name) acc.toolName = piece.name;
      if (typeof piece.args === 'string') acc.argsBuffer += piece.args;
    }
    return true;
  }

  /**
   * 从完整 AIMessage.tool_calls 中补齐 acc 字段；
   * 对从未在分片中出现过的则现场创建。
   * 返回需要 emit `tool_call` 事件的 acc 列表（按 tool_calls 顺序）。
   */
  upsertFromFinal(toolCalls: NonNullable<RawMessageChunk['tool_calls']>): ToolCallAcc[] {
    const out: ToolCallAcc[] = [];
    for (const tc of toolCalls) {
      if (!tc?.id) continue;
      let acc = this.accsByToolCallId.get(tc.id);
      if (!acc) {
        acc = {
          toolCallId: tc.id,
          toolName: tc.name ?? '',
          argsBuffer:
            typeof tc.args === 'string' ? tc.args : tc.args ? safeJsonStringify(tc.args) : '',
          startEmitted: false,
        };
        this.accsByToolCallId.set(tc.id, acc);
      } else {
        if (!acc.toolName && tc.name) acc.toolName = tc.name;
        if (!acc.argsBuffer && tc.args) {
          acc.argsBuffer = typeof tc.args === 'string' ? tc.args : safeJsonStringify(tc.args);
        }
      }
      out.push(acc);
    }
    return out;
  }

  getByToolCallId(toolCallId: string): ToolCallAcc | undefined {
    return this.accsByToolCallId.get(toolCallId);
  }

  /** 幂等地标记 acc 已 emit；返回 true 表示首次 emit（外层应发出事件）。 */
  tryMarkStart(acc: ToolCallAcc): boolean {
    if (acc.startEmitted || !acc.toolCallId || !acc.toolName) return false;
    acc.startEmitted = true;
    return true;
  }
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
    const internalController = new AbortController();
    const onParentAbort = () => internalController.abort(parentSignal?.reason);
    if (parentSignal?.aborted) {
      internalController.abort(parentSignal.reason);
    } else {
      parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    }

    // 2) 超时定时器（config.timeout 单位：秒）
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        internalController.abort(new Error(`Subagent timed out after ${config.timeout}s`));
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
        ? (this.inheritedModelConfig ?? { modelName: 'inherit' })
        : { modelName: config.model };
      if (isInherit && !this.inheritedModelConfig && process.env.NODE_ENV !== 'production') {
        console.warn(
          `${logPrefix} model='inherit' but no inheritedModelConfig provided; ` +
            `falling back to createChatModel default (modelName="inherit").`,
        );
      }
      const model = createChatModel(modelConfig);
      const provider = inferProvider(modelConfig);
      const agent = createBaseAgent({
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
        signal: internalController.signal,
        // 增加 'updates' 用于补抓 ToolMessage（subagent 内部工具结果）
        streamMode: ['messages', 'updates'],
        recursionLimit: Math.max(2, config.maxTurns) * 2,
      };
      if (ctxThreadId) {
        streamOpts.configurable = { thread_id: ctxThreadId };
      }
      const stream = await agent.stream(input as any, streamOpts);

      // 跨 chunk 状态
      const tracker = new ToolCallTracker();
      const runState = {
        aiMessageCount: 0,
        // 累计完整文本，用于在终态尝试 schema 解析
        aggregatedFinalText: '',
      };

      const buildToolCallEvent = (acc: ToolCallAcc): SubagentEvent => ({
        kind: 'tool_call',
        taskId,
        toolCallId: acc.toolCallId,
        toolName: acc.toolName,
        arguments: acc.argsBuffer || '{}',
      });

      // 分支 handler：messages 流（AIMessage chunk）
      const handleAiMessageChunk = function* (msgChunk: RawMessageChunk): Generator<SubagentEvent> {
        // 5a) tool_call 分片：累积后跳过本帧，等完整 AIMessage 再 emit
        if (tracker.ingestChunks(msgChunk.tool_call_chunks)) return;

        // 5b) 完整 AIMessage：可能含 tool_calls 和/或 文本
        const content = msgChunk.content;
        const toolCalls = msgChunk.tool_calls;
        const hasFinalToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
        const hasText =
          (typeof content === 'string' && content.trim().length > 0) ||
          (Array.isArray(content) && content.length > 0);

        // 纯空心跳：忽略
        if (!hasText && !hasFinalToolCalls) return;

        // 5c) 拿到完整 tool_calls 时，把累积完成的 acc emit 为 tool_call 事件
        if (hasFinalToolCalls && toolCalls) {
          for (const acc of tracker.upsertFromFinal(toolCalls)) {
            if (tracker.tryMarkStart(acc)) yield buildToolCallEvent(acc);
          }
        }

        // 5d) 文本分类：含 tool_calls → reasoning（planning），否则 → 正文（最终答案）
        const contentStr = typeof content === 'string' && content.trim() ? content : '';
        if (contentStr && !hasFinalToolCalls) {
          runState.aggregatedFinalText += contentStr;
        }
        runState.aiMessageCount += 1;
        yield {
          kind: 'ai_message',
          taskId,
          message: slimSerializeMessage(msgChunk),
          index: runState.aiMessageCount,
          total: runState.aiMessageCount,
          reasoning: hasFinalToolCalls && contentStr ? contentStr : undefined,
        };
      };

      // 分支 handler：updates 流（补抓 ToolMessage）
      const handleUpdatesPayload = function* (
        payload: Record<string, any>,
      ): Generator<SubagentEvent> {
        for (const nodeName of Object.keys(payload)) {
          const msgs = payload[nodeName]?.messages;
          if (!Array.isArray(msgs)) continue;
          for (const rawMsg of msgs) {
            const msg = toRawMessage(rawMsg);
            if (msg._getType?.() !== 'tool') continue;

            const toolCallId: string = msg.tool_call_id ?? '';
            const acc = tracker.getByToolCallId(toolCallId);
            // 兜底：若 messages 流没机会 emit tool_call_start（例如未推完整 AIMessage 即 tool 已执行），先补一次
            if (acc && tracker.tryMarkStart(acc)) {
              yield buildToolCallEvent(acc);
            }
            const toolName = msg.name ?? acc?.toolName ?? '';
            const status = msg.status; // 'error' / undefined
            yield {
              kind: 'tool_result',
              taskId,
              toolCallId,
              toolName,
              result: msg.content,
              success: status !== 'error',
              errorMessage: status === 'error' ? String(msg.content ?? '') : undefined,
            };
          }
        }
      };

      for await (const chunk of stream) {
        const [mode, payload] = chunk as [string, unknown];

        if (mode === 'messages') {
          // payload 形如 [msgChunk, metadata]
          const msgChunkRaw = Array.isArray(payload) ? payload[0] : undefined;
          if (!msgChunkRaw) continue;
          const msgChunk = toRawMessage(msgChunkRaw);
          if ((msgChunk._getType?.() ?? msgChunk.type) !== 'ai') continue;
          yield* handleAiMessageChunk(msgChunk);
          continue;
        }

        if (mode === 'updates' && payload && typeof payload === 'object') {
          yield* handleUpdatesPayload(payload as Record<string, any>);
        }
      }

      // 6) 终态：completed -------------------------------------------------
      // 尝试从最终输出中提取 schema 化的 final-report 块
      const { json: structured, markdown } = extractSubagentReport(runState.aggregatedFinalText);
      const resultText = runState.aggregatedFinalText.length > 0 ? markdown : null;
      yield {
        kind: 'completed',
        taskId,
        result: resultText,
        structured: structured ?? null,
      };
      console.info(
        `${logPrefix} completed (messages=${runState.aiMessageCount}, structured=${
          structured ? 'yes' : 'no'
        })`,
      );
    } catch (err: any) {
      const aborted = internalController.signal.aborted || parentSignal?.aborted;

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
        ? msg.content.map((c: any) => (typeof c === 'string' ? c : (c?.text ?? ''))).join('')
        : '';
  const toolCalls = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((tc: any) => ({
        id: tc?.id,
        name: tc?.name,
        argKeys:
          tc?.args && typeof tc.args === 'object' ? Object.keys(tc.args).slice(0, 8) : undefined,
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
