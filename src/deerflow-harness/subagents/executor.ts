import { v4 as uuidv4 } from 'uuid';
import { HumanMessage } from '@langchain/core/messages';
import { StructuredToolInterface } from '@langchain/core/tools';

import { createBaseAgent } from '../agents/factory';
import { createChatModel, inferProvider } from '../models';
import { getContext } from '../runtime/context';
import { ModelConfig, SubagentEvent, SUBAGENT_STREAM_TAG } from '../types';
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
   *
   * args 覆盖语义（关键不变量）：final 帧的 `tc.args` 永远比 chunks 累积更可信
   * （chunks 在某些 OpenAI 兼容流下会被截断/乱序），因此只要 final 帧给出非空
   * args，就**无条件覆盖** acc.argsBuffer。
   *
   * 返回需要 emit `tool_call` 事件的 acc 列表（按 tool_calls 顺序）。
   */
  upsertFromFinal(toolCalls: NonNullable<RawMessageChunk['tool_calls']>): ToolCallAcc[] {
    const out: ToolCallAcc[] = [];
    for (const toolCall of toolCalls) {
      if (!toolCall?.id) continue;
      let acc = this.accsByToolCallId.get(toolCall.id);
      if (!acc) {
        acc = {
          toolCallId: toolCall.id,
          toolName: toolCall.name ?? '',
          argsBuffer: stringifyToolArgs(toolCall.args),
          startEmitted: false,
        };
        this.accsByToolCallId.set(toolCall.id, acc);
      } else {
        if (!acc.toolName && toolCall.name) acc.toolName = toolCall.name;
        const finalArgs = stringifyToolArgs(toolCall.args);
        if (finalArgs.length > 0) acc.argsBuffer = finalArgs;
      }
      out.push(acc);
    }
    return out;
  }

  getByToolCallId(toolCallId: string): ToolCallAcc | undefined {
    return this.accsByToolCallId.get(toolCallId);
  }

  /** 所有累积器（用于终态扫描丢弃 ghost）。 */
  allAccs(): ToolCallAcc[] {
    const seen = new Set<ToolCallAcc>();
    for (const acc of this.accsByToolCallId.values()) seen.add(acc);
    for (const acc of this.accsByChunkIndex.values()) seen.add(acc);
    return [...seen];
  }

  /**
   * 幂等地标记 acc 已 emit。
   * 必须满足：toolCallId / toolName 齐全，且 argsBuffer 是合法的非空 args。
   * 不达标返回 false（外层不 emit），等待 final/updates 兜底。
   */
  tryMarkStart(acc: ToolCallAcc): boolean {
    if (acc.startEmitted) return false;
    if (!acc.toolCallId || !acc.toolName) return false;
    if (!isCompleteArgs(acc.argsBuffer)) return false;
    acc.startEmitted = true;
    return true;
  }
}

/**
 * 序列化 LangChain message chunk 为体积可控的 plain object。
 *
 * 历史版本会把整个 message（含原始 tool_call_chunks、additional_kwargs）
 * 全部 dump，导致单帧体积 100KB+，前端 SSE 解析卡顿、表现像"已完成还在转"。
 * 新版只保留前端真正需要的：text + tool_calls 摘要。
 */
function slimSerializeMessage(message: unknown): Record<string, unknown> {
  if (!message || typeof message !== 'object')
    return { type: 'unknown', text: String(message ?? '') };
  const messageObj = message as {
    content?: unknown;
    tool_calls?: unknown;
    _getType?: () => string;
    type?: unknown;
  };
  const content = messageObj.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((c) => {
              if (typeof c === 'string') return c;
              if (c && typeof c === 'object') {
                const t = (c as { text?: unknown }).text;
                return typeof t === 'string' ? t : '';
              }
              return '';
            })
            .join('')
        : '';
  const toolCallsRaw = messageObj.tool_calls;
  const toolCalls = Array.isArray(toolCallsRaw)
    ? toolCallsRaw.map((toolCall) => {
        const tcObj = toolCall as { id?: unknown; name?: unknown; args?: unknown };
        return {
          id: tcObj?.id,
          name: tcObj?.name,
          argKeys:
            tcObj?.args && typeof tcObj.args === 'object'
              ? Object.keys(tcObj.args as Record<string, unknown>).slice(0, 8)
              : undefined,
        };
      })
    : undefined;
  return {
    type: messageObj?._getType?.() ?? messageObj.type ?? 'ai',
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

/**
 * 把 tool_call.args 序列化成字符串（与 OpenAI 协议对齐）：
 * - 字符串：原样返回
 * - 对象/数组：JSON.stringify
 * - 其它：空串
 */
function stringifyToolArgs(args: unknown): string {
  if (typeof args === 'string') return args;
  if (args && typeof args === 'object') return safeJsonStringify(args);
  return '';
}

/**
 * 判定 argsBuffer 是否「完整可用」：
 * - 空串 / `'{}'` / 空对象 / 仅空白 → 不完整
 * - 可被 JSON.parse 成非空对象 / 非空字符串 → 完整
 */
function isCompleteArgs(buffer: string): boolean {
  if (!buffer) return false;
  const trimmed = buffer.trim();
  if (trimmed.length === 0 || trimmed === '{}' || trimmed === '[]') return false;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || parsed === undefined) return false;
    if (typeof parsed === 'object') return Object.keys(parsed).length > 0;
    if (typeof parsed === 'string') return parsed.length > 0;
    return true;
  } catch {
    return false;
  }
}

/** 项目内的 web 搜索工具命名集合（与前端 timeline 解析口径保持一致） */
const SEARCH_WEB_TOOL_NAMES: ReadonlySet<string> = new Set([
  'search_web_tool',
  'web_search',
  'tavily_search',
]);

function isSearchWebToolName(name: string | undefined): boolean {
  return !!name && SEARCH_WEB_TOOL_NAMES.has(name);
}

/**
 * 累积 subagent 内部 web 搜索工具的来源列表，用于 task_completed 兜底回填。
 *
 * 解析口径：
 * - search_web_tool 输出形如 `结果 N: 标题: xxx 来源: <URL> 内容: ... ---`
 * - 字符串结果 / 对象结果 / 数组结果均尝试解析；按 url 去重，限制 50 条。
 */
class SearchSourcesAccumulator {
  private readonly map = new Map<string, { title: string; url: string }>();
  private static readonly LIMIT = 50;
  private static readonly TEXT_PATTERN = /标题:\s*([^\n]+?)\s*\n\s*来源:\s*(https?:\/\/[^\s]+)/g;

  ingest(raw: unknown): void {
    if (this.map.size >= SearchSourcesAccumulator.LIMIT) return;
    if (typeof raw === 'string') {
      this.ingestString(raw);
      return;
    }
    if (Array.isArray(raw)) {
      for (const item of raw) this.ingestObject(item);
      return;
    }
    if (raw && typeof raw === 'object') {
      const obj = raw as { results?: unknown };
      if (Array.isArray(obj.results)) {
        for (const item of obj.results) this.ingestObject(item);
      } else {
        this.ingestObject(raw);
      }
    }
  }

  private ingestString(text: string): void {
    let match: RegExpExecArray | null;
    SearchSourcesAccumulator.TEXT_PATTERN.lastIndex = 0;
    while ((match = SearchSourcesAccumulator.TEXT_PATTERN.exec(text)) !== null) {
      this.add(match[1].trim(), match[2].trim());
      if (this.map.size >= SearchSourcesAccumulator.LIMIT) return;
    }
  }

  private ingestObject(item: unknown): void {
    if (!item || typeof item !== 'object') return;
    const obj = item as { title?: unknown; url?: unknown; sourceUrl?: unknown; link?: unknown };
    const url =
      (typeof obj.url === 'string' && obj.url) ||
      (typeof obj.sourceUrl === 'string' && obj.sourceUrl) ||
      (typeof obj.link === 'string' && obj.link) ||
      '';
    const title = (typeof obj.title === 'string' && obj.title) || url;
    if (!url || !title) return;
    this.add(title, url);
  }

  private add(title: string, url: string): void {
    if (this.map.has(url)) return;
    this.map.set(url, { title, url });
  }

  size(): number {
    return this.map.size;
  }

  snapshot(): Array<{ title: string; url: string }> {
    return [...this.map.values()];
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
        // 给本次子 agent run 打上流式标记 tag，避免子 agent 内容被误当作 lead 自身的 stream_chunk。
        // 子 agent 自身（本流）不做该过滤，task_running 照常推送。
        tags: [SUBAGENT_STREAM_TAG],
      };
      if (ctxThreadId) {
        streamOpts.configurable = { thread_id: ctxThreadId };
      }
      // input 形状由 LangGraph ReAct agent 自身的 state schema 决定，但当前 typing
      // 返回的是 ThreadStateAnnotation 联合（带 sandbox/threadData/uploads 等可选字段）。
      // 子图入参实际只需要 `messages`，其它字段由 reducer 默认初始化，因此用单层
      // 结构性 cast 跨过 schema 联合类型 —— 符合 project.md §2.2 外部边界例外。
      const stream = await agent.stream(
        input as unknown as Parameters<typeof agent.stream>[0],
        streamOpts,
      );

      // 跨 chunk 状态
      const tracker = new ToolCallTracker();
      const sourcesAccumulator = new SearchSourcesAccumulator();
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
        // 5a) tool_call 分片到达：本轮要调用工具，此前累积的文本是「planning 开场白」
        //     （如 "I'll search for ..."），绝非最终报告。清空 aggregatedFinalText，
        //     保证它最终只含「最后一次工具调用之后」的纯文本（真正的最终报告）。
        if (tracker.ingestChunks(msgChunk.tool_call_chunks)) {
          runState.aggregatedFinalText = '';
          return;
        }

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
          // 同 5a：本轮要调用工具 → 丢弃此前累积的 planning 文本
          runState.aggregatedFinalText = '';
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
            const success = status !== 'error';
            // 把 search_web_tool 的文本结果解析为 sources 累积
            if (success && isSearchWebToolName(toolName)) {
              sourcesAccumulator.ingest(msg.content);
            }
            yield {
              kind: 'tool_result',
              taskId,
              toolCallId,
              toolName,
              result: msg.content,
              success,
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
      // 6a) 终态前扫描 tracker：args 已完整但漏发的补 emit；args 始终不完整的 acc
      //     视为「ghost」直接丢弃，不向上推送，避免 UI 出现可展开但内容空白的工具行。
      let droppedGhostCount = 0;
      for (const acc of tracker.allAccs()) {
        if (acc.startEmitted) continue;
        if (!acc.toolCallId || !acc.toolName) {
          droppedGhostCount += 1;
          continue;
        }
        if (!isCompleteArgs(acc.argsBuffer)) {
          droppedGhostCount += 1;
          continue;
        }
        // 漏发兜底：args 已完整但因前置时序未走 emit
        acc.startEmitted = true;
        yield buildToolCallEvent(acc);
      }
      if (droppedGhostCount > 0 && process.env.NODE_ENV !== 'production') {
        console.info(
          `${logPrefix} dropped ${droppedGhostCount} ghost tool_call(s) (incomplete args)`,
        );
      }

      // 6b) 尝试从最终输出中提取 schema 化的 final-report 块
      const { json: structured, markdown } = extractSubagentReport(runState.aggregatedFinalText);
      const resultText = runState.aggregatedFinalText.length > 0 ? markdown : null;
      yield {
        kind: 'completed',
        taskId,
        result: resultText,
        structured: structured ?? null,
        accumulatedSources: sourcesAccumulator.snapshot(),
      };
      console.info(
        `${logPrefix} completed (messages=${runState.aiMessageCount}, structured=${
          structured ? 'yes' : 'no'
        }, sources=${sourcesAccumulator.size()})`,
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
