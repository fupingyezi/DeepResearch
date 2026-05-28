import { v4 as uuidv4 } from 'uuid';
import { HumanMessage } from '@langchain/core/messages';
import { StructuredToolInterface } from '@langchain/core/tools';
import { BaseCheckpointSaver } from '@langchain/langgraph';

import { createChatModel, inferProvider } from './models';
import { createBaseAgent } from './agents/factory';
import {
  SYSTEM_PROMPT,
  buildLeadAgentSystemPrompt,
} from './agents/lead-agent';
import { searchWebTool } from './tools';
import { ModelConfig, ClientOptions, AgentConfigKey } from './types';
import { AgentEventType, createAgentEvent, type AgentEvent } from './types/agent-event';
import {
  toClientAgentEvent,
  type ClientAgentEventStream,
  type ClientAgentEvent,
} from './runtime/sse';
import { getContext } from './runtime/context';

interface RuntimeRunOptions {
  memoryEnabled: boolean;
  agentName: string;
  userId: string | null;
  availableSkills?: string[];
}

function buildConfigKey(modelConfig: ModelConfig, opts: RuntimeRunOptions): AgentConfigKey {
  return JSON.stringify([
    modelConfig.modelName,
    opts.memoryEnabled,
    opts.agentName,
    opts.availableSkills?.sort() ?? [],
  ]);
}

/**
 * 共享 AsyncLocalStorage：与 runtime/context.ts 中的 als 是同一对象。
 * 这里通过 import 拿到 getContext，再用 als.run 包一层把 modelConfig 注入到
 * 当前 RuntimeContext 中，供 task-tool 在 inherit 模式下读取。
 *
 * 注：runtime/context.ts 的 als 是模块级私有变量，无法跨模块共享。
 * 我们通过 getContext() 拿到外层 ctx 后，使用本地 als 嵌套一层 store
 * 是不可行的。改为：DeerFlowClient.stream() 直接修改外层 ctx 的字段（als
 * 的 store 是引用类型），让 currentModelConfig 在同一 ctx 上可见。
 */

/**
 * DeerFlowClient
 *
 * 进程级单例（见 app/api/threads/_service.ts）。对齐 deer-flow 2.0：
 * - lead-agent 永远启用 subagent 能力（taskTool + subagentLimitMiddleware
 *   始终注入），不再有 plan-mode；
 * - 每轮 stream 把当前 modelConfig 写入 RuntimeContext.currentModelConfig，
 *   供 'inherit' 模式的 subagent（如 general-purpose）复用。
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
    this.defaultTools = options?.tools ?? [searchWebTool];
    this.explicitSystemPrompt = options?.systemPrompt;
    this.checkpointer = options?.checkpointer;
    this.baseOptions = {
      agentName: options?.agentName ?? 'lead',
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
   * 计算本轮 stream 的运行期开关：以 baseOptions 为底。
   * 不再读取 metadata 中的 is_plan_mode / subagent_enabled / agent_name 三开关。
   */
  private resolveRuntimeOptions(_metadata?: Record<string, any>): RuntimeRunOptions {
    const userId = this.baseOptions.userId ?? getContext()?.user_id ?? null;
    return {
      memoryEnabled: !!this.baseOptions.memoryEnabled,
      agentName: this.baseOptions.agentName ?? 'lead',
      userId,
      availableSkills: this.baseOptions.availableSkills,
    };
  }

  /**
   * 构建本轮 systemPrompt：
   * - caller 显式 systemPrompt → 原样使用（不再注入 memory）；
   * - memoryEnabled → lead-agent prompt builder（叠加 memory）；
   * - 否则退化为静态 SYSTEM_PROMPT。
   */
  private async resolveSystemPrompt(opts: RuntimeRunOptions): Promise<string> {
    if (this.explicitSystemPrompt) return this.explicitSystemPrompt;

    const promptOpts = { agentName: opts.agentName, userId: opts.userId };

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
      features: {
        memory: opts.memoryEnabled,
      },
    });

    if (cacheable) this.agentCache.set(key, agent);

    const builtinNames = effectiveTools.map((t) => (t as { name?: string }).name ?? '?').join(', ');
    console.log(
      `[DeerFlowClient] Agent created/rebuilt (name=${opts.agentName}, ` +
        `memoryEnabled=${opts.memoryEnabled}, ` +
        `caller-tools=[${builtinNames}], ` +
        `explicitTools=${this.hasExplicitTools})`,
    );
    return agent;
  }

  /**
   * 向 agent 发送消息并以 ClientAgentEvent 异步生成器的形式返回事件流。
   *
   * 与旧实现的差异：
   * - 不再读 metadata 上的 is_plan_mode / subagent_enabled / agent_name；
   * - 把当前 modelConfig 写入 RuntimeContext.currentModelConfig，供
   *   'inherit' 模式的 subagent（如 general-purpose）在 SubagentExecutor 中复用。
   */
  async *stream(
    message: string,
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
    if (ctx) {
      ctx.currentModelConfig = this.modelConfig;
    }

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

      // 把 task-tool 通过 LangGraph custom writer 推送的 task_* payload
      // 翻译为 internal AgentEvent，再由 toClientAgentEvent 映射成对外协议。
      // STATE_UPDATE / HUMAN_INTERRUPT 事件枚举保留以兼容旧 SSE 协议，
      // 但新链路（无 plan-mode）不会再触发它们。
      const handleCustomPayload = function* (
        raw: any,
      ): Generator<ClientAgentEvent> {
        if (!raw || typeof raw !== 'object') return;
        const t = raw.type;
        const meta = { sessionId: effectiveThreadId, ...metadata };

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
