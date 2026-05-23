import { v4 as uuidv4 } from 'uuid';
import { HumanMessage } from '@langchain/core/messages';
import { StructuredToolInterface } from '@langchain/core/tools';
import { BaseCheckpointSaver } from '@langchain/langgraph';

import { createChatModel, inferProvider } from './models';
import { createBaseAgent } from './agents/factory';
import {
  SYSTEM_PROMPT,
  buildLeadAgentSystemPrompt,
  buildPlanModeSystemPrompt,
} from './agents/lead-agent';
import { searchWebTool, buildPlanModeTools } from './tools';
import { ModelConfig, ClientOptions, AgentConfigKey } from './types';
import { AgentEventType, createAgentEvent, type AgentEvent } from './types/agent-event';
import {
  toClientAgentEvent,
  type ClientAgentEventStream,
  type ClientAgentEvent,
} from './runtime/sse';
import { getContext } from './runtime/context';

interface RuntimeRunOptions {
  planMode: boolean;
  subagentEnabled: boolean;
  memoryEnabled: boolean;
  agentName: string;
  userId: string | null;
  availableSkills?: string[];
}

function buildConfigKey(modelConfig: ModelConfig, opts: RuntimeRunOptions): AgentConfigKey {
  return JSON.stringify([
    modelConfig.modelName,
    opts.planMode,
    opts.subagentEnabled,
    opts.memoryEnabled,
    opts.agentName,
    opts.availableSkills?.sort() ?? [],
  ]);
}

/**
 * DeerFlowClient
 *
 * 进程级单例（见 app/api/threads/_service.ts）。运行期 metadata 三开关
 * （is_plan_mode / subagent_enabled / agent_name）只在 `stream()` 内部按
 * **本次调用的局部副本**使用，不会污染 this.options，避免并发请求互相覆盖。
 */
export class DeerFlowClient {
  /** Agent 实例缓存：按 RuntimeRunOptions 派生的 key 分组缓存。 */
  private agentCache = new Map<AgentConfigKey, any>();

  private modelConfig: ModelConfig;
  private defaultTools: StructuredToolInterface[];
  /** 是否由 caller 显式传入 tools；为 true 时关闭 plan-mode 自动 tools 注入。 */
  private hasExplicitTools: boolean;
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
    this.defaultTools = options?.tools ?? [searchWebTool];
    this.explicitSystemPrompt = options?.systemPrompt;
    this.checkpointer = options?.checkpointer;
    this.baseOptions = {
      agentName: options?.agentName ?? 'lead',
      planMode: options?.planMode ?? false,
      subagentEnabled: options?.subagentEnabled ?? false,
      memoryEnabled: options?.memoryEnabled ?? false,
      userId: options?.userId,
      availableSkills: options?.availableSkills,
    };
  }

  /** 清空所有 agent 缓存（保留 baseOptions）。 */
  resetAgent(): void {
    this.agentCache.clear();
  }

  /**
   * 计算本轮 stream 的运行期开关：以 baseOptions 为底，metadata 覆盖。
   */
  private resolveRuntimeOptions(metadata?: Record<string, unknown>): RuntimeRunOptions {
    const m = metadata ?? {};
    const planMode =
      typeof m.is_plan_mode === 'boolean' ? (m.is_plan_mode as boolean) : !!this.baseOptions.planMode;
    const subagentEnabled =
      typeof m.subagent_enabled === 'boolean'
        ? (m.subagent_enabled as boolean)
        : !!this.baseOptions.subagentEnabled;
    const agentName =
      typeof m.agent_name === 'string' && m.agent_name
        ? (m.agent_name as string)
        : this.baseOptions.agentName ?? 'lead';
    const userId =
      this.baseOptions.userId ?? getContext()?.user_id ?? null;

    return {
      planMode,
      subagentEnabled,
      memoryEnabled: !!this.baseOptions.memoryEnabled,
      agentName,
      userId,
      availableSkills: this.baseOptions.availableSkills,
    };
  }

  /**
   * 构建本轮要交给 createAgent 的 systemPrompt：
   * - caller 显式 systemPrompt → 原样使用（不再注入 memory / plan-mode）；
   * - planMode=true → 使用 plan-mode prompt（可叠加 memory）；
   * - memoryEnabled → lead-agent prompt builder（叠加 memory）；
   * - 否则退化为静态 SYSTEM_PROMPT。
   */
  private async resolveSystemPrompt(opts: RuntimeRunOptions): Promise<string> {
    if (this.explicitSystemPrompt) return this.explicitSystemPrompt;

    const promptOpts = { agentName: opts.agentName, userId: opts.userId };

    if (opts.planMode) {
      try {
        return await buildPlanModeSystemPrompt(promptOpts);
      } catch (e) {
        console.warn(
          '[DeerFlowClient] buildPlanModeSystemPrompt failed, fallback to lead prompt:',
          e,
        );
      }
    }

    if (opts.memoryEnabled) {
      try {
        return await buildLeadAgentSystemPrompt(promptOpts);
      } catch (e) {
        console.warn(
          '[DeerFlowClient] buildLeadAgentSystemPrompt failed, fallback to SYSTEM_PROMPT:',
          e,
        );
      }
    }

    return SYSTEM_PROMPT;
  }

  /**
   * 解析本轮要绑定到 agent 的工具集。
   *
   * - caller 显式传 tools → 始终使用 caller 的工具集（不自动追加 plan-mode 工具）。
   * - planMode=true → 使用 buildPlanModeTools()（含 emit_plan/emit_report/ask_clarification +
   *   search_web_tool）；task 工具由 factory 在 features.subagent=true 时自动注入。
   * - 普通模式 → 沿用 constructor 默认的 [searchWebTool]。
   */
  private resolveTools(opts: RuntimeRunOptions): StructuredToolInterface[] {
    if (this.hasExplicitTools) return this.defaultTools;
    if (opts.planMode) return buildPlanModeTools();
    return this.defaultTools;
  }

  /**
   * 按 RuntimeRunOptions 获取或构建 agent 实例。
   * memoryEnabled=true 时不缓存（每轮 prompt 含最新 memory，必须重建）。
   */
  private async ensureAgent(systemPrompt: string, opts: RuntimeRunOptions): Promise<any> {
    const key = buildConfigKey(this.modelConfig, opts);
    const cacheable = !opts.memoryEnabled;

    if (cacheable) {
      const cached = this.agentCache.get(key);
      if (cached) return cached;
    }

    const model = createChatModel(this.modelConfig);
    const provider = inferProvider(this.modelConfig);
    const effectiveTools = this.resolveTools(opts);

    const agent = createBaseAgent({
      model,
      tools: effectiveTools,
      systemPrompt,
      checkpointer: this.checkpointer,
      provider,
      planMode: opts.planMode,
      features: {
        subagent: opts.subagentEnabled,
        memory: opts.memoryEnabled,
      },
    });

    if (cacheable) this.agentCache.set(key, agent);

    const builtinNames = effectiveTools.map((t) => (t as { name?: string }).name ?? '?').join(', ');
    console.log(
      `[DeerFlowClient] Agent created/rebuilt (name=${opts.agentName}, ` +
        `planMode=${opts.planMode}, ` +
        `subagentEnabled=${opts.subagentEnabled}, ` +
        `memoryEnabled=${opts.memoryEnabled}, ` +
        `caller-tools=[${builtinNames}])`,
    );
    return agent;
  }

  /**
   * 向 agent 发送消息并以 ClientAgentEvent 异步生成器的形式返回事件流。
   *
   * metadata 中的运行期开关：
   * - is_plan_mode: boolean       → 切换 plan-mode prompt + 工具集
   * - subagent_enabled: boolean   → 启用 features.subagent（注入 task 工具 + SubagentLimit MW）
   * - agent_name: string          → 覆盖 agentName（影响日志 / memory 隔离）
   *
   * 上述开关只对本次调用生效，不污染 baseOptions（多线程/并发安全）。
   */
  async *stream(
    message: string,
    threadId?: string,
    metadata?: Record<string, unknown>,
  ): ClientAgentEventStream {
    // 1. 解析本次调用的运行期开关（不修改 this.baseOptions）
    const runOpts = this.resolveRuntimeOptions(metadata);

    // 显式参数优先；其次从 ALS 兜底；最后 fallback 到新 uuid
    const effectiveThreadId = threadId ?? getContext()?.thread_id ?? uuidv4();
    const agentId = runOpts.agentName;

    /** 内部辅助：构造 internal AgentEvent，映射到 ClientAgentEvent；null 表示 drop。 */
    const emit = (event: AgentEvent): ClientAgentEvent | null => toClientAgentEvent(event);

    // 2. 构建本轮 systemPrompt + agent
    const systemPrompt = await this.resolveSystemPrompt(runOpts);
    const agent = await this.ensureAgent(systemPrompt, runOpts);

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

    try {
      // 4. 构造输入 — LangGraph ReActAgent 接受 { messages }
      // memory 已经通过 systemPrompt 注入，不再额外塞 SystemMessage 到 messages 头部，
      // 避免重复 / 顺序与 summarizationMiddleware 冲突。
      const input = { messages: [new HumanMessage(message)] };

      const config = {
        configurable: {
          thread_id: effectiveThreadId,
        },
        // 把 agentName / userId 透传给 LangGraph runtime.context，
        // 供 memoryMiddleware.afterAgent 在入队时读取。
        context: {
          agentName: agentId,
          userId: runOpts.userId,
        },
      };

      // streamMode:
      //  - "messages": AI token / tool_call 分片
      //  - "updates":  节点 state delta，承载 ToolMessage
      //  - "custom":   工具内部通过 LangGraph writer 推送的自定义事件（subagent task_* /
      //                emit_plan/emit_report state_update / clarification human_interrupt）
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

      const handleAiChunk = function* (msgChunk: any): Generator<ClientAgentEvent> {
        const content = typeof msgChunk.content === 'string' ? msgChunk.content : '';
        if (content) {
          const ev = emit(
            createAgentEvent<AgentEvent>(
              AgentEventType.LLM_STREAM,
              agentId,
              { text: content },
              { sessionId: effectiveThreadId, ...metadata },
            ),
          );
          if (ev) yield ev;
        }

        const tcChunks = msgChunk.tool_call_chunks as
          | Array<{ index?: number; id?: string; name?: string; args?: string }>
          | undefined;
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

      // 把 task-tool / emit_plan / emit_report / clarification 通过 LangGraph custom writer
      // 推送的 payload 翻译为 internal AgentEvent，再由 toClientAgentEvent 映射成对外协议。
      const handleCustomPayload = function* (
        raw: any,
      ): Generator<ClientAgentEvent> {
        if (!raw || typeof raw !== 'object') return;
        const t = raw.type;
        const meta = { sessionId: effectiveThreadId, ...metadata };

        // —— state_update（emit_plan / emit_report） ——
        if (t === 'state_update') {
          const stateType = raw.state_type ?? raw.stateType;
          if (!stateType) {
            if (debug) console.log('[custom payload state_update missing state_type]', raw);
            return;
          }
          const ev = emit(
            createAgentEvent<AgentEvent>(
              AgentEventType.STATE_UPDATE,
              agentId,
              { stateType, data: raw.data },
              meta,
            ),
          );
          if (ev) yield ev;
          return;
        }

        // —— human_interrupt（ask_clarification） ——
        if (t === 'human_interrupt') {
          const payload = (raw.payload ?? {}) as { question?: string; details?: unknown };
          const ev = emit(
            createAgentEvent<AgentEvent>(
              AgentEventType.HUMAN_INTERRUPT,
              agentId,
              {
                question: payload.question ?? '',
                details: payload.details ?? null,
              },
              meta,
            ),
          );
          if (ev) yield ev;
          return;
        }

        // —— task_*（taskTool 推送的 subagent 进度） ——
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
                { taskId, result: raw.result ?? null },
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
          const [msgChunk] = payload as [any, any];
          // ToolMessage 统一走 updates 分支，避免双重 emit
          if (msgChunk?._getType?.() === 'ai') {
            yield* handleAiChunk(msgChunk);
          }
          continue;
        }

        if (mode !== 'updates' || !payload || typeof payload !== 'object') continue;

        for (const nodeName of Object.keys(payload)) {
          const msgs = payload[nodeName]?.messages;

          if (debug) {
            const summary = Array.isArray(msgs)
              ? msgs
                  .map((m: any) => {
                    const tt = m?._getType?.() ?? '?';
                    if (tt === 'ai') {
                      const tcs = (m?.tool_calls ?? []).map((tc: any) => `${tc.name}#${tc.id}`);
                      return `ai(tool_calls=[${tcs.join(',')}])`;
                    }
                    if (tt === 'tool') return `tool(id=${m?.tool_call_id},status=${m?.status ?? 'ok'})`;
                    return tt;
                  })
                  .join(', ')
              : '(no messages)';
            console.log(`[node update] ${nodeName} → ${summary}`);
          }

          if (!Array.isArray(msgs)) continue;
          for (const msg of msgs) {
            if (msg?._getType?.() === 'tool') yield* handleToolMessage(msg);
          }
        }
      }

      // 兜底：模型只出 tool_call 但未触发 tool node 的极端情况
      for (const acc of toolCallsByIndex.values()) {
        const startEvt = emitToolCallStart(acc);
        if (startEvt) yield startEvt;
      }

      // 注：此前会 emit LLM_COMPLETE，但前端协议已不接收该枚举，因此不再发出。
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
