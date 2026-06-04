import { v4 as uuidv4 } from 'uuid';
import { HumanMessage } from '@langchain/core/messages';
import { StructuredToolInterface } from '@langchain/core/tools';
import { BaseCheckpointSaver, Command } from '@langchain/langgraph';

import { createChatModel, inferProvider } from './models';
import { createBaseAgent } from './agents/factory';
import { SYSTEM_PROMPT, buildLeadAgentSystemPrompt } from './agents/lead-agent';
import { searchWebTool, askClarificationTool } from './tools';
import { ModelConfig, ClientOptions, AgentConfigKey, SUBAGENT_STREAM_TAG } from './types';
import { AgentEventType, createAgentEvent, type AgentEvent } from './types/agent-event';
import {
  toClientAgentEvent,
  type ClientAgentEventStream,
  type ClientAgentEvent,
} from './runtime/sse';
import { getContext } from './runtime/context';
import { loadMcpTools, getEnabledMcpSignature, buildMcpToolsSection } from './mcp';
import { getEnabledSkillsSignature } from './skills';

interface RuntimeRunOptions {
  memoryEnabled: boolean;
  autoTitleEnabled: boolean;
  threadDataEnabled: boolean;
  uploadsEnabled: boolean;
  agentName: string;
  userId: string | null;
  availableSkills?: string[];
}

function buildConfigKey(
  modelConfig: ModelConfig,
  opts: RuntimeRunOptions,
  mcpSignature: string,
  skillSignature: string,
): AgentConfigKey {
  return JSON.stringify([
    modelConfig.modelName,
    opts.memoryEnabled,
    opts.autoTitleEnabled,
    opts.threadDataEnabled,
    opts.uploadsEnabled,
    opts.agentName,
    opts.availableSkills?.sort() ?? [],
    mcpSignature,
    skillSignature,
  ]);
}

/**
 * metadata 显式 boolean 覆盖 baseOptions：
 * - 必须严格 `typeof === 'boolean'` 才覆盖；
 * - 防止 `metadata.<key> = undefined` 被解释为 false 导致服务级默认被静默关闭。
 */
function pickBooleanOverride(metadataValue: unknown, fallback: boolean): boolean {
  return typeof metadataValue === 'boolean' ? metadataValue : fallback;
}

/**
 * 判定缓冲文本是否以 markdown 研究报告的起始结构开头。
 *
 * 命中条件（去除前导空白后）：
 * - `# ` / `## ` / `### ` 标题
 * - `> **` 摘要引用块（报告范式约定的摘要卡片）
 *
 * 用于把「最终报告正文」与「工具调用前的规划叙述」区分开：报告范式强制以
 * `# 标题` 开头，规划叙述不会以 `#` 开头，因此该信号不会误判规划叙述。
 */
function looksLikeFinalReportStart(text: string): boolean {
  const head = text.replace(/^[\s\u3000]+/, '');
  return /^#{1,3}\s/.test(head) || /^>\s*\*\*/.test(head);
}

/**
 * DeerFlowClient
 *
 * 进程级单例（见 app/api/threads/_service.ts）。lead-agent 永远启用 subagent
 * 能力（taskTool + subagentLimitMiddleware 始终注入）。每轮 stream 把当前
 * modelConfig 写入 RuntimeContext.currentModelConfig，供 'inherit' 模式的
 * subagent（如 general-purpose）复用。
 */
export class DeerFlowClient {
  /** Agent 实例缓存：按 RuntimeRunOptions 派生的 key 分组缓存。 */
  private agentCache = new Map<AgentConfigKey, any>();

  private modelConfig: ModelConfig;
  private defaultTools: StructuredToolInterface[];
  /**
   * 是否由 caller 显式传入 tools（保留为内部状态字段，便于未来需要按
   * "caller-owns-tools"语义额外处理时复用，例如禁用某些自动注入）。
   */
  private readonly hasExplicitTools: boolean;
  private explicitSystemPrompt?: string;
  private checkpointer?: BaseCheckpointSaver;
  private baseOptions: ClientOptions;

  constructor(
    modelConfig: ModelConfig,
    options?: ClientOptions & {
      tools?: StructuredToolInterface[];
      systemPrompt?: string;
      checkpointer?: BaseCheckpointSaver;
    },
  ) {
    this.modelConfig = modelConfig;
    this.hasExplicitTools = Array.isArray(options?.tools);
    this.defaultTools = options?.tools ?? [searchWebTool, askClarificationTool];
    this.explicitSystemPrompt = options?.systemPrompt;
    this.checkpointer = options?.checkpointer;
    this.baseOptions = {
      agentName: options?.agentName ?? 'lead',
      memoryEnabled: options?.memoryEnabled ?? false,
      autoTitleEnabled: options?.autoTitleEnabled ?? false,
      threadDataEnabled: options?.threadDataEnabled ?? false,
      uploadsEnabled: options?.uploadsEnabled ?? false,
      userId: options?.userId,
      availableSkills: options?.availableSkills,
    };
  }

  /** 清空所有 agent 缓存（保留 baseOptions）。 */
  resetAgent(): void {
    this.agentCache.clear();
  }

  /**
   * 计算本轮 stream 的运行期开关：以 baseOptions 为底，metadata 显式传值时覆盖。
   *
   * 优先级（仅以下键支持运行期覆盖）：
   *   1. metadata.<key> (boolean) — 本次请求显式覆盖
   *   2. baseOptions.<key>        — 服务级默认（_service.ts 注入）
   *
   * 支持运行期覆盖的键：memoryEnabled / autoTitleEnabled / threadDataEnabled /
   * uploadsEnabled。`agentName` / `userId` / `availableSkills` 暂不开放单次请求覆盖。
   *
   * 不修改 this.baseOptions，所有覆盖只作用于本次 stream。
   * 透传 metadata 不能为 truthy 即覆盖：必须严格判定 typeof === 'boolean'，
   * 否则 `metadata.memoryEnabled = undefined` 也会被解释为 false。
   */
  private resolveRuntimeOptions(metadata?: Record<string, any>): RuntimeRunOptions {
    const userId = this.baseOptions.userId ?? getContext()?.user_id ?? null;
    return {
      memoryEnabled: pickBooleanOverride(metadata?.memoryEnabled, !!this.baseOptions.memoryEnabled),
      autoTitleEnabled: pickBooleanOverride(
        metadata?.autoTitleEnabled,
        !!this.baseOptions.autoTitleEnabled,
      ),
      threadDataEnabled: pickBooleanOverride(
        metadata?.threadDataEnabled,
        !!this.baseOptions.threadDataEnabled,
      ),
      uploadsEnabled: pickBooleanOverride(
        metadata?.uploadsEnabled,
        !!this.baseOptions.uploadsEnabled,
      ),
      agentName: this.baseOptions.agentName ?? 'lead',
      userId,
      availableSkills: this.baseOptions.availableSkills,
    };
  }

  /**
   * 构建本轮 systemPrompt：
   * - caller 显式 systemPrompt → 原样使用（不再注入 memory/skills/mcp）；
   * - 否则 → lead-agent prompt builder：始终注入启用技能与已加载 MCP 工具，memory 按 opts 开关注入。
   *
   * mcpTools 由 caller 预加载并透传，使「绑定到 agent 的工具」与「写入提示的工具」严格一致，
   * 避免模型不知道自己已接入 MCP 而回答"未配置 MCP"。
   */
  private async resolveSystemPrompt(
    opts: RuntimeRunOptions,
    mcpTools: StructuredToolInterface[],
  ): Promise<string> {
    if (this.explicitSystemPrompt) return this.explicitSystemPrompt;

    // memory 作用域 agent 名固定为 null：lead 对话使用「跨 agent 全局 per-user」
    // 记忆（users/{userId}/memory.json），对齐 deer-flow 2.0 默认对话 agent_name=None。
    // 注意与展示用 agentId（opts.agentName='lead'，用于事件/生命周期/缓存 key）解耦——
    // 这里**不要**用 opts.agentName，否则会落到 per-agent 文件而读不到跨 agent 全局记忆。
    try {
      return await buildLeadAgentSystemPrompt({
        agentName: null,
        userId: opts.userId,
        injectMemory: opts.memoryEnabled,
        mcpToolsSection: buildMcpToolsSection(mcpTools),
      });
    } catch (e) {
      console.warn(
        '[DeerFlowClient] buildLeadAgentSystemPrompt failed, fallback to SYSTEM_PROMPT:',
        e,
      );
    }

    return SYSTEM_PROMPT;
  }

  /**
   * 解析本轮要绑定到 agent 的工具集。
   * - caller 显式传 tools → 始终使用 caller 的工具集
   * - 否则 → 沿用 constructor 默认 tools（默认 [searchWebTool]）
   * task 工具由 factory.assembleFromFeatures 始终注入。
   */
  private resolveTools(_opts: RuntimeRunOptions): StructuredToolInterface[] {
    return this.defaultTools;
  }

  /**
   * 按 RuntimeRunOptions 获取或构建 agent 实例。
   * memoryEnabled=true 时不缓存（每轮 prompt 含最新 memory，必须重建）。
   *
   * mcpTools 由 caller 预加载并透传（与 systemPrompt 注入的工具同源）；缓存键纳入
   * MCP/skill 启用签名，使配置变更后（关闭 memory 的可缓存场景）agent 自动重建。
   */
  private async ensureAgent(
    systemPrompt: string,
    opts: RuntimeRunOptions,
    mcpTools: StructuredToolInterface[],
  ): Promise<any> {
    const mcpSignature = await getEnabledMcpSignature();
    const skillSignature = await getEnabledSkillsSignature();
    const key = buildConfigKey(this.modelConfig, opts, mcpSignature, skillSignature);
    const cacheable = !opts.memoryEnabled;

    if (cacheable) {
      const cached = this.agentCache.get(key);
      if (cached) return cached;
    }

    const model = createChatModel(this.modelConfig);
    const provider = inferProvider(this.modelConfig);
    const effectiveTools = [...this.resolveTools(opts), ...mcpTools];

    const agent = createBaseAgent({
      model,
      tools: effectiveTools,
      systemPrompt,
      checkpointer: this.checkpointer,
      provider,
      features: {
        memory: opts.memoryEnabled,
        autoTitle: opts.autoTitleEnabled,
        threadData: opts.threadDataEnabled,
        uploads: opts.uploadsEnabled,
      },
    });

    if (cacheable) this.agentCache.set(key, agent);

    if (process.env.MW_TRACE === '1' || process.env.MW_TRACE === 'true') {
      const builtinNames = effectiveTools
        .map((t) => (t as { name?: string }).name ?? '?')
        .join(', ');
      console.log(
        `[DeerFlowClient] Agent created/rebuilt (name=${opts.agentName}, ` +
          `memoryEnabled=${opts.memoryEnabled}, ` +
          `mcpTools=${mcpTools.length}, ` +
          `caller-tools=[${builtinNames}], ` +
          `explicitTools=${this.hasExplicitTools})`,
      );
    }
    return agent;
  }

  /**
   * 向 agent 发送消息并以 ClientAgentEvent 异步生成器的形式返回事件流。
   *
   * 每轮把当前 modelConfig 写入 RuntimeContext.currentModelConfig，供
   * 'inherit' 模式的 subagent（如 general-purpose）在 SubagentExecutor 中复用。
   */
  async *stream(
    message: string,
    threadId?: string,
    metadata?: Record<string, any>,
  ): ClientAgentEventStream {
    yield* this.streamWithInput({ messages: [new HumanMessage(message)] }, threadId, metadata);
  }

  /**
   * 续跑被 interrupt 暂停的图：以 Command({ resume: decision }) 作为输入，
   * 复用同一 thread_id（共享 checkpoint），事件协议与 stream() 完全一致。
   * 用于 ask_clarification 等 HITL 工具的「用户作答 → 继续推进」闭环。
   */
  async *resumeStream(
    decision: unknown,
    threadId?: string,
    metadata?: Record<string, any>,
  ): ClientAgentEventStream {
    yield* this.streamWithInput(new Command({ resume: decision }), threadId, metadata);
  }

  /**
   * 向 agent 发送输入（首轮 HumanMessage 或 resume Command）并以 ClientAgentEvent
   * 异步生成器的形式返回事件流。
   *
   * 每轮把当前 modelConfig 写入 RuntimeContext.currentModelConfig，供
   * 'inherit' 模式的 subagent（如 general-purpose）在 SubagentExecutor 中复用。
   */
  private async *streamWithInput(
    input: { messages: HumanMessage[] } | Command,
    threadId?: string,
    metadata?: Record<string, any>,
  ): ClientAgentEventStream {
    // 1. 解析本次调用的运行期开关（不修改 this.baseOptions）
    const runOpts = this.resolveRuntimeOptions(metadata);

    // 显式参数优先；其次从 ALS 兜底；最后 fallback 到新 uuid
    const ctx = getContext();
    const effectiveThreadId = threadId ?? ctx?.thread_id ?? uuidv4();
    const agentId = runOpts.agentName;

    // 把当前 ModelConfig 注入到外层 RuntimeContext，让 task-tool 在 'inherit'
    // 模式下能读到与 lead 完全一致的模型配置（含 baseUrl/apiKey）。
    // 这是对外层 als store 的"原地写"——als store 是引用类型，子调用链共享同一对象。
    //
    // memory 作用域：lead 对话**不写** ctx.agent_name（保持 undefined → null），
    // 使 memoryMiddleware 把对话总结落到「跨 agent 全局 per-user」记忆
    // users/{userId}/memory.json，与注入侧 / 读 API 三侧一致（对齐 deer-flow 2.0）。
    // agentId（='lead'）仅用于对外事件/生命周期/缓存 key，不参与 memory 路径决策。
    if (ctx) {
      ctx.currentModelConfig = this.modelConfig;
    }

    /** 内部辅助：构造 internal AgentEvent，映射到 ClientAgentEvent；null 表示 drop。 */
    const emit = (event: AgentEvent): ClientAgentEvent | null => toClientAgentEvent(event);

    // 2. 构建本轮 systemPrompt + agent
    // 先加载一次 MCP 工具（loadMcpTools 内部按签名缓存），同源喂给 prompt 注入与 agent 绑定，
    // 保证「模型在提示里看到的 MCP 工具」与「实际可调用的工具」严格一致。
    const mcpTools = await loadMcpTools();
    const systemPrompt = await this.resolveSystemPrompt(runOpts, mcpTools);
    const agent = await this.ensureAgent(systemPrompt, runOpts, mcpTools);

    // 3. lifecycle start
    {
      const ev = emit(
        createAgentEvent<AgentEvent>(
          AgentEventType.LIFECYCLE,
          agentId,
          { stage: 'start', timestamp: Date.now() },
          { sessionId: effectiveThreadId, ...metadata },
        ),
      );
      if (ev) yield ev;
    }

    // ── 调试开关：打印完整 AI 输出 ──
    // 这些状态需要在 try / finally 之间共享，因此提升到 try 之外，
    // 防止 try 块在声明这些变量之前抛错时，finally 引用 ReferenceError。
    const debugAi = process.env.DEERFLOW_DEBUG === '1' || process.env.DEERFLOW_DEBUG_AI === '1';
    const aiLogPrefix = `[ai-debug ${agentId} ${effectiveThreadId.slice(0, 8)}]`;
    let fullAiText = '';
    let fullAiReasoning = '';
    const debugLog = (...args: unknown[]): void => {
      if (debugAi) console.log(aiLogPrefix, ...args);
    };

    try {
      const config = {
        configurable: {
          thread_id: effectiveThreadId,
          currentModelConfig: this.modelConfig,
        },
        // 把 memory 作用域 agentName / userId 透传给 LangGraph runtime.context，
        // 供 memoryMiddleware.afterAgent 在入队时读取（作为 ALS 的 fallback）。
        // agentName 固定为 null：lead 对话用跨 agent 全局 per-user 记忆；
        // 这里**不要**透传 agentId('lead')，否则 fallback 会把对话总结写回 per-agent 文件。
        context: {
          agentName: null,
          userId: runOpts.userId,
        },
      };

      // streamMode:
      //  - "messages": AI token / tool_call 分片
      //  - "updates":  节点 state delta，承载 ToolMessage
      //  - "custom":   工具内部通过 LangGraph writer 推送的自定义事件（subagent task_*）
      const stream = await agent.stream(input, {
        ...config,
        streamMode: ['messages', 'updates', 'custom'],
      });

      // OpenAI 兼容流：tool_call 的 args 按 index 分片到达，需累加后再 emit。
      type ToolCallAcc = {
        toolCallId: string;
        toolName: string;
        argsBuffer: string;
        startEmitted: boolean;
      };
      const toolCallsByIndex = new Map<number, ToolCallAcc>();
      const toolCallsById = new Map<string, ToolCallAcc>();
      const debug = process.env.NODE_ENV !== 'production';

      // ── Content classification state ──
      // 原则：含 tool_calls 的 AI message 的 content 是
      // "思考/规划"（归入 reasoning），不含 tool_calls 的 content 是
      // "最终答案"（归入正文）。
      let stepHasToolCalls = false;
      let pendingContent = '';
      // 是否已确认进入「最终报告正文」。命中 markdown 报告起始信号（# 标题 / > **摘要**）
      // 后置 true，之后该 step 的 content 直接作为正文流式下发，保持打字机效果。
      // 规划叙述不以 # 开头，会一直缓冲到 step 边界再按 tool_calls 有无分类为 reasoning。
      let inFinalReportBody = false;

      const emitToolCallStart = (acc: ToolCallAcc): ClientAgentEvent | null => {
        if (acc.startEmitted || !acc.toolCallId || !acc.toolName) return null;
        acc.startEmitted = true;
        return emit(
          createAgentEvent<AgentEvent>(
            AgentEventType.TOOL_CALL_START,
            agentId,
            {
              toolCallId: acc.toolCallId,
              toolName: acc.toolName,
              arguments: acc.argsBuffer || '{}',
            },
            { sessionId: effectiveThreadId, ...metadata },
          ),
        );
      };

      /** 刷新待分类缓冲：asReasoning=true → reasoning，否则 → text */
      const flushPendingContent = function* (asReasoning: boolean): Generator<ClientAgentEvent> {
        if (!pendingContent) return;
        if (asReasoning) fullAiReasoning += pendingContent;
        else fullAiText += pendingContent;
        const ev = emit(
          createAgentEvent<AgentEvent>(
            AgentEventType.LLM_STREAM,
            agentId,
            asReasoning ? { reasoning: pendingContent } : { text: pendingContent },
            { sessionId: effectiveThreadId, ...metadata },
          ),
        );
        if (ev) yield ev;
        pendingContent = '';
      };

      const handleAiChunk = function* (msgChunk: any): Generator<ClientAgentEvent> {
        const content = typeof msgChunk.content === 'string' ? msgChunk.content : '';
        const tcChunks = msgChunk.tool_call_chunks as
          | Array<{ index?: number; id?: string; name?: string; args?: string }>
          | undefined;

        if (debugAi) {
          // 完整原始 chunk（按需查看 additional_kwargs / response_metadata）
          const reasoning =
            typeof msgChunk?.additional_kwargs?.reasoning_content === 'string'
              ? msgChunk.additional_kwargs.reasoning_content
              : '';
          if (content || reasoning || tcChunks?.length) {
            debugLog('chunk', {
              content,
              reasoning,
              tool_call_chunks: tcChunks,
            });
          }
        }

        // tool_call_chunks 首次出现 → 当前 step 确认含 tool calls，
        // 将此前缓冲的 content 一并刷为 reasoning
        if (tcChunks?.length && !stepHasToolCalls) {
          stepHasToolCalls = true;
          yield* flushPendingContent(true);
        }

        if (content) {
          if (stepHasToolCalls) {
            // 含 tool_calls 的 step：content 是 planning → reasoning
            fullAiReasoning += content;
            const ev = emit(
              createAgentEvent<AgentEvent>(
                AgentEventType.LLM_STREAM,
                agentId,
                { reasoning: content },
                { sessionId: effectiveThreadId, ...metadata },
              ),
            );
            if (ev) yield ev;
          } else if (inFinalReportBody) {
            // 已确认进入最终报告正文：后续 content 直接作为 text 流式下发
            fullAiText += content;
            const ev = emit(
              createAgentEvent<AgentEvent>(
                AgentEventType.LLM_STREAM,
                agentId,
                { text: content },
                { sessionId: effectiveThreadId, ...metadata },
              ),
            );
            if (ev) yield ev;
          } else {
            // 分类待定：先缓冲。命中 markdown 报告起始信号（# 标题 / > **摘要**）
            // → 判定为最终正文并开始流式；否则继续缓冲，待 tool_call_chunks 出现时
            // 整体转 reasoning（规划叙述不以 # 开头，绝不会误判为正文）。
            pendingContent += content;
            if (looksLikeFinalReportStart(pendingContent)) {
              inFinalReportBody = true;
              yield* flushPendingContent(false);
            }
          }
        }

        if (!tcChunks?.length) return;
        for (const piece of tcChunks) {
          const idx = piece.index ?? 0;
          let acc = toolCallsByIndex.get(idx);
          if (!acc) {
            acc = { toolCallId: '', toolName: '', argsBuffer: '', startEmitted: false };
            toolCallsByIndex.set(idx, acc);
          }
          if (piece.id) {
            acc.toolCallId = piece.id;
            toolCallsById.set(piece.id, acc);
          }
          if (piece.name) acc.toolName = piece.name;
          if (typeof piece.args === 'string') acc.argsBuffer += piece.args;
        }
      };

      const handleToolMessage = function* (msg: any): Generator<ClientAgentEvent> {
        // 兜底刷缓冲 & 重置 step 状态（ToolMessage 标志 step 边界）
        if (pendingContent) {
          yield* flushPendingContent(stepHasToolCalls);
        }
        stepHasToolCalls = false;
        inFinalReportBody = false;

        if (debugAi) {
          const resultText =
            typeof msg?.content === 'string'
              ? msg.content
              : (() => {
                  try {
                    return JSON.stringify(msg?.content);
                  } catch {
                    return '[unserializable]';
                  }
                })();
          debugLog('tool_message', {
            tool_call_id: msg?.tool_call_id,
            name: msg?.name,
            status: msg?.status ?? 'ok',
            content: resultText,
          });
        }

        const toolCallId = msg.tool_call_id ?? '';
        const acc = toolCallsById.get(toolCallId);
        if (acc) {
          const startEvt = emitToolCallStart(acc);
          if (startEvt) yield startEvt;
        }
        const ev = emit(
          createAgentEvent<AgentEvent>(
            AgentEventType.TOOL_CALL_RESULT,
            agentId,
            {
              toolCallId,
              toolName: msg.name ?? '',
              result: msg.content,
              success: true,
            },
            { sessionId: effectiveThreadId, ...metadata },
          ),
        );
        if (ev) yield ev;
      };

      // 把 task-tool 通过 LangGraph custom writer 推送的 task_* payload
      // 翻译为 internal AgentEvent，再由 toClientAgentEvent 映射成对外协议。
      const handleCustomPayload = function* (raw: any): Generator<ClientAgentEvent> {
        if (!raw || typeof raw !== 'object') return;
        if (debugAi) debugLog('custom', raw);
        const t = raw.type;
        const meta = { sessionId: effectiveThreadId, ...metadata };

        // task_*（taskTool 推送的 subagent 进度）
        const taskId: string = raw.task_id ?? '';
        switch (t) {
          case 'task_started': {
            const ev = emit(
              createAgentEvent<AgentEvent>(
                AgentEventType.TASK_STARTED,
                agentId,
                {
                  taskId,
                  description: raw.description,
                  subagentType: raw.subagent_type,
                },
                meta,
              ),
            );
            if (ev) yield ev;
            return;
          }
          case 'task_running': {
            const ev = emit(
              createAgentEvent<AgentEvent>(
                AgentEventType.TASK_RUNNING,
                agentId,
                {
                  taskId,
                  message: raw.message,
                  messageIndex: raw.message_index ?? 0,
                  totalMessages: raw.total_messages ?? 0,
                  reasoning: raw.reasoning,
                },
                meta,
              ),
            );
            if (ev) yield ev;
            return;
          }
          case 'task_completed': {
            const ev = emit(
              createAgentEvent<AgentEvent>(
                AgentEventType.TASK_COMPLETED,
                agentId,
                {
                  taskId,
                  result: raw.result ?? null,
                  // structured: 来自 subagent final-report fenced block 的解析结果
                  structured: raw.structured ?? null,
                },
                meta,
              ),
            );
            if (ev) yield ev;
            return;
          }
          case 'task_failed': {
            const ev = emit(
              createAgentEvent<AgentEvent>(
                AgentEventType.TASK_FAILED,
                agentId,
                { taskId, error: raw.error ?? null },
                meta,
              ),
            );
            if (ev) yield ev;
            return;
          }
          case 'task_cancelled': {
            const ev = emit(
              createAgentEvent<AgentEvent>(
                AgentEventType.TASK_CANCELLED,
                agentId,
                { taskId, error: raw.error ?? null },
                meta,
              ),
            );
            if (ev) yield ev;
            return;
          }
          case 'task_timed_out': {
            const ev = emit(
              createAgentEvent<AgentEvent>(
                AgentEventType.TASK_TIMED_OUT,
                agentId,
                { taskId, error: raw.error ?? null },
                meta,
              ),
            );
            if (ev) yield ev;
            return;
          }
          case 'task_tool_call':
          case 'task_tool_result': {
            // subagent 内部工具调用透传：直接走 TASK_PROGRESS 通道，
            // 前端按 status='tool_call' / 'tool_result' 挂到对应 subagent_task step 下。
            const isCall = t === 'task_tool_call';
            const ev = emit(
              createAgentEvent<AgentEvent>(
                AgentEventType.TASK_PROGRESS,
                agentId,
                {
                  taskId,
                  status: isCall ? 'tool_call' : 'tool_result',
                  toolCallId: raw.tool_call_id,
                  toolName: raw.tool_name,
                  ...(isCall
                    ? { arguments: raw.arguments }
                    : {
                        toolResult: raw.result,
                        toolSuccess: raw.success,
                        toolErrorMessage: raw.error_message,
                      }),
                },
                meta,
              ),
            );
            if (ev) yield ev;
            return;
          }
          default:
            if (debug) console.log('[custom payload ignored]', raw);
            return;
        }
      };

      for await (const chunk of stream) {
        const [mode, payload] = chunk as [string, any];

        if (mode === 'custom') {
          yield* handleCustomPayload(payload);
          continue;
        }

        if (mode === 'messages') {
          const [msgChunk, msgMeta] = payload as [any, any];
          // 过滤子 agent 泄漏帧：子 agent 在 task tool 内用 agent.stream 运行，
          // 内容只应通过 task_progress（custom 通道）归到对应子 agent 卡片。
          const tags = msgMeta?.tags;
          if (Array.isArray(tags) && tags.includes(SUBAGENT_STREAM_TAG)) {
            continue;
          }
          // ToolMessage 统一走 updates 分支，避免双重 emit
          if (msgChunk?._getType?.() === 'ai') {
            yield* handleAiChunk(msgChunk);
          }
          continue;
        }

        if (mode !== 'updates' || !payload || typeof payload !== 'object') continue;

        // LangGraph 原生 interrupt：updates 中的 __interrupt__ 承载 ask_clarification
        // 等 HITL 工具抛出的暂停请求。转成 HUMAN_INTERRUPT 客户端事件，等待 resume。
        const interrupts = (payload as Record<string, unknown>).__interrupt__;
        if (Array.isArray(interrupts)) {
          if (debugAi) debugLog('interrupt', interrupts);
          for (const intr of interrupts) {
            const value = (intr as { value?: unknown })?.value ?? intr;
            const obj =
              value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
            const question =
              obj && typeof obj.question === 'string'
                ? obj.question
                : typeof value === 'string'
                  ? value
                  : '需要你的确认';
            const details = obj ? (obj.details ?? null) : null;
            const ev = emit(
              createAgentEvent<AgentEvent>(
                AgentEventType.HUMAN_INTERRUPT,
                agentId,
                { question, details },
                { sessionId: effectiveThreadId, ...metadata },
              ),
            );
            if (ev) yield ev;
          }
          continue;
        }

        for (const nodeName of Object.keys(payload)) {
          const msgs = payload[nodeName]?.messages;

          if (!Array.isArray(msgs)) continue;
          for (const msg of msgs) {
            const msgType = msg?._getType?.();
            if (msgType === 'ai') {
              if (debugAi) {
                // updates 模式的完整 AIMessage：含完整 content 与已聚合的 tool_calls
                const fullContent =
                  typeof msg?.content === 'string'
                    ? msg.content
                    : (() => {
                        try {
                          return JSON.stringify(msg?.content);
                        } catch {
                          return '[unserializable]';
                        }
                      })();
                debugLog('ai_message_full', {
                  node: nodeName,
                  content: fullContent,
                  tool_calls: msg?.tool_calls ?? [],
                  reasoning_content: msg?.additional_kwargs?.reasoning_content,
                  finish_reason: msg?.response_metadata?.finish_reason,
                });
              }
              // updates 模式的完整 AIMessage 标志 agent step 结束，
              // 刷缓冲并按 tool_calls 有无决定分类
              const hasToolCalls = !!msg?.tool_calls?.length;
              if (pendingContent) {
                yield* flushPendingContent(hasToolCalls || stepHasToolCalls);
              }
              stepHasToolCalls = false;
              inFinalReportBody = false;
            } else if (msgType === 'tool') {
              yield* handleToolMessage(msg);
            }
          }
        }
      }

      // 刷残留缓冲（最终答案可能仍在 pendingContent 中）
      if (pendingContent) {
        yield* flushPendingContent(stepHasToolCalls);
      }

      // 兜底：模型只出 tool_call 但未触发 tool node 的极端情况
      for (const acc of toolCallsByIndex.values()) {
        const startEvt = emitToolCallStart(acc);
        if (startEvt) yield startEvt;
      }
    } catch (error: any) {
      const ev = emit(
        createAgentEvent<AgentEvent>(
          AgentEventType.ERROR,
          agentId,
          {
            errorCode: 'AGENT_STREAM_ERROR',
            errorMessage: error?.message ?? 'Unknown error during stream',
            recoverable: false,
          },
          { sessionId: effectiveThreadId, ...metadata },
        ),
      );
      if (ev) yield ev;
    } finally {
      if (debugAi) {
        debugLog('=== full AI output ===');
        if (fullAiReasoning) debugLog('reasoning(full):\n' + fullAiReasoning);
        if (fullAiText) debugLog('text(full):\n' + fullAiText);
        if (!fullAiReasoning && !fullAiText) debugLog('(no AI text captured)');
      }
      // 6. lifecycle done
      const ev = emit(
        createAgentEvent<AgentEvent>(
          AgentEventType.LIFECYCLE,
          agentId,
          { stage: 'done', timestamp: Date.now() },
          { sessionId: effectiveThreadId, ...metadata },
        ),
      );
      if (ev) yield ev;
    }
  }
}
