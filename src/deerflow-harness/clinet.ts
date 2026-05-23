import { v4 as uuidv4 } from 'uuid';
import { HumanMessage } from '@langchain/core/messages';
import { StructuredToolInterface } from '@langchain/core/tools';
import { BaseCheckpointSaver } from '@langchain/langgraph';

import { createChatModel, inferProvider } from './models';
import { createBaseAgent } from './agents/factory';
import { SYSTEM_PROMPT, buildLeadAgentSystemPrompt } from './agents/lead-agent';
import { searchWebTool } from './tools';
import { ModelConfig, ClientOptions, AgentConfigKey } from './types';
import { AgentEventType, createAgentEvent, type AgentEvent } from './types/agent-event';
import { toClientAgentEvent, type ClientAgentEventStream } from './runtime/sse';
import { getContext } from './runtime/context';

function buildConfigKey(modelConfig: ModelConfig, opts: ClientOptions): AgentConfigKey {
  return JSON.stringify([
    modelConfig.modelName,
    opts.planMode ?? false,
    opts.subagentEnabled ?? false,
    opts.memoryEnabled ?? false,
    opts.agentName ?? 'default',
    opts.availableSkills?.sort() ?? [],
  ]);
}

export class DeerFlowClient {
  private agent: any = null;
  private agentConfigKey: AgentConfigKey | null = null;

  private modelConfig: ModelConfig;
  private tools: StructuredToolInterface[];
  /** caller 显式传入的 systemPrompt；若给定则关闭 lead-agent 的动态 memory 注入。 */
  private explicitSystemPrompt?: string;
  private checkpointer?: BaseCheckpointSaver;
  private options: ClientOptions;

  constructor(
    modelConfig: ModelConfig,
    options?: ClientOptions & {
      tools?: StructuredToolInterface[];
      systemPrompt?: string;
      checkpointer?: BaseCheckpointSaver;
    },
  ) {
    this.modelConfig = modelConfig;
    this.tools = options?.tools ?? [searchWebTool];
    this.explicitSystemPrompt = options?.systemPrompt;
    this.checkpointer = options?.checkpointer;
    this.options = {
      agentName: options?.agentName ?? 'lead',
      planMode: options?.planMode ?? false,
      subagentEnabled: options?.subagentEnabled ?? false,
      memoryEnabled: options?.memoryEnabled ?? false,
      userId: options?.userId,
      availableSkills: options?.availableSkills,
    };
  }

  resetAgent(): void {
    this.agent = null;
    this.agentConfigKey = null;
  }

  /**
   * 构建本轮要交给 createAgent 的 systemPrompt：
   * - 如果 caller 显式传了 systemPrompt，则原样使用（不再注入 memory）；
   * - 否则当 memoryEnabled 时，调用 lead-agent prompt builder，把最新 `<memory>` 块拼到 prompt 末尾；
   * - memory 关闭则退化为静态 SYSTEM_PROMPT。
   */
  private async resolveSystemPrompt(userId: string | null): Promise<string> {
    if (this.explicitSystemPrompt) return this.explicitSystemPrompt;
    if (this.options.memoryEnabled) {
      try {
        return await buildLeadAgentSystemPrompt({
          agentName: this.options.agentName ?? null,
          userId,
        });
      } catch (e) {
        console.warn('[DeerFlowClient] buildLeadAgentSystemPrompt failed, fallback to SYSTEM_PROMPT:', e);
      }
    }
    return SYSTEM_PROMPT;
  }

  private async ensureAgent(systemPrompt: string): Promise<void> {
    const key = buildConfigKey(this.modelConfig, this.options);

    // memory 注入随每轮变化，因此 memory 启用时不走 cache，每轮重建以获得最新 prompt。
    const cacheable = !this.options.memoryEnabled;
    if (cacheable && this.agent !== null && this.agentConfigKey === key) {
      return;
    }

    const model = createChatModel(this.modelConfig);
    const provider = inferProvider(this.modelConfig);

    this.agent = createBaseAgent({
      model,
      tools: this.tools,
      systemPrompt,
      checkpointer: this.checkpointer,
      provider,
      features: {
        subagent: this.options.subagentEnabled === true,
        memory: this.options.memoryEnabled === true,
      },
    });

    this.agentConfigKey = cacheable ? key : null;
    const builtinNames = this.tools.map((t) => (t as { name?: string }).name ?? '?').join(', ');
    console.log(
      `[DeerFlowClient] Agent created/rebuilt (name=${this.options.agentName}, ` +
        `subagentEnabled=${this.options.subagentEnabled === true}, ` +
        `memoryEnabled=${this.options.memoryEnabled === true}, ` +
        `caller-tools=[${builtinNames}])`,
    );
  }

  /**
   * 向 agent 发送消息并以 ClientAgentEvent 异步生成器的形式返回事件流。
   */
  async *stream(
    message: string,
    threadId?: string,
    metadata?: Record<string, unknown>,
  ): ClientAgentEventStream {
    // 显式参数优先；其次从 ALS 兜底；最后 fallback 到新 uuid
    const effectiveThreadId = threadId ?? getContext()?.thread_id ?? uuidv4();
    const agentId = this.options.agentName ?? 'lead';
    const effectiveUserId =
      this.options.userId ?? getContext()?.user_id ?? null;

    /** 内部辅助：构造 internal AgentEvent 并即时映射输出 */
    const emit = (event: AgentEvent) => toClientAgentEvent(event);

    // 1. 构建本轮 systemPrompt（memoryEnabled 时会拉最新 <memory> 注入到 prompt 末尾），
    //    然后基于该 prompt 构建/复用 agent。
    const systemPrompt = await this.resolveSystemPrompt(effectiveUserId);
    await this.ensureAgent(systemPrompt);

    // 2. lifecycle start
    yield emit(
      createAgentEvent<AgentEvent>(
        AgentEventType.LIFECYCLE,
        agentId,
        { stage: 'start', timestamp: Date.now() },
        { sessionId: effectiveThreadId, ...metadata },
      ),
    );

    try {
      // 3. 构造输入 — LangGraph ReActAgent 接受 { messages }
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
          userId: effectiveUserId,
        },
      };

      // streamMode:
      //  - "messages": AI token / tool_call 分片
      //  - "updates":  节点 state delta，承载 ToolMessage
      //  - "custom":   工具内部通过 LangGraph writer 推送的自定义事件（subagent task_*）
      const stream = await this.agent!.stream(input, {
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

      const emitToolCallStart = (acc: ToolCallAcc) => {
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

      const handleAiChunk = function* (msgChunk: any) {
        const content = typeof msgChunk.content === 'string' ? msgChunk.content : '';
        if (content) {
          yield emit(
            createAgentEvent<AgentEvent>(
              AgentEventType.LLM_STREAM,
              agentId,
              { text: content },
              { sessionId: effectiveThreadId, ...metadata },
            ),
          );
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

      const handleToolMessage = function* (msg: any) {
        const toolCallId = msg.tool_call_id ?? '';
        const acc = toolCallsById.get(toolCallId);
        if (acc) {
          const startEvt = emitToolCallStart(acc);
          if (startEvt) yield startEvt;
        }
        yield emit(
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
      };

      // 把 task-tool 通过 LangGraph custom writer 推送的 task_* payload 转成 AgentEvent
      const handleCustomPayload = function* (raw: any) {
        if (!raw || typeof raw !== 'object') return;
        const t = raw.type;
        const taskId: string = raw.task_id ?? '';
        const meta = { sessionId: effectiveThreadId, ...metadata };

        switch (t) {
          case 'task_started':
            yield emit(
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
            return;
          case 'task_running':
            yield emit(
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
            return;
          case 'task_completed':
            yield emit(
              createAgentEvent<AgentEvent>(
                AgentEventType.TASK_COMPLETED,
                agentId,
                { taskId, result: raw.result ?? null },
                meta,
              ),
            );
            return;
          case 'task_failed':
            yield emit(
              createAgentEvent<AgentEvent>(
                AgentEventType.TASK_FAILED,
                agentId,
                { taskId, error: raw.error ?? null },
                meta,
              ),
            );
            return;
          case 'task_cancelled':
            yield emit(
              createAgentEvent<AgentEvent>(
                AgentEventType.TASK_CANCELLED,
                agentId,
                { taskId, error: raw.error ?? null },
                meta,
              ),
            );
            return;
          case 'task_timed_out':
            yield emit(
              createAgentEvent<AgentEvent>(
                AgentEventType.TASK_TIMED_OUT,
                agentId,
                { taskId, error: raw.error ?? null },
                meta,
              ),
            );
            return;
          default:
            // 未识别的 custom payload 直接忽略，避免污染前端事件流
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

      // 流正常结束：标记 LLM 调用完成
      yield emit(
        createAgentEvent<AgentEvent>(
          AgentEventType.LLM_COMPLETE,
          agentId,
          {},
          { sessionId: effectiveThreadId, ...metadata },
        ),
      );
    } catch (error: any) {
      yield emit(
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
    } finally {
      // 6. lifecycle done
      yield emit(
        createAgentEvent<AgentEvent>(
          AgentEventType.LIFECYCLE,
          agentId,
          { stage: 'done', timestamp: Date.now() },
          { sessionId: effectiveThreadId, ...metadata },
        ),
      );
    }
  }
}
