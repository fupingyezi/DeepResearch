import { v4 as uuidv4 } from 'uuid';
import { HumanMessage } from '@langchain/core/messages';
import { StructuredToolInterface } from '@langchain/core/tools';
import { BaseCheckpointSaver } from '@langchain/langgraph';

import { createChatModel, inferProvider } from './models';
import { createBaseAgent } from './agents/factory';
import { SYSTEM_PROMPT } from './agents/lead-agent';
import { searchWebTool } from './tools';
import { ModelConfig, ClientOptions, AgentConfigKey } from './types';
import { AgentEventType, createAgentEvent, type AgentEvent } from './types/agent-event';
import { toClientAgentEvent, type ClientAgentEventStream } from './runtime/sse';

function buildConfigKey(modelConfig: ModelConfig, opts: ClientOptions): AgentConfigKey {
  return JSON.stringify([
    modelConfig.modelName,
    opts.planMode ?? false,
    opts.subagentEnabled ?? false,
    opts.agentName ?? 'default',
    opts.availableSkills?.sort() ?? [],
  ]);
}

export class DeerFlowClient {
  private agent: any = null;
  private agentConfigKey: AgentConfigKey | null = null;

  private modelConfig: ModelConfig;
  private tools: StructuredToolInterface[];
  private systemPrompt: string;
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
    this.systemPrompt = options?.systemPrompt ?? SYSTEM_PROMPT;
    this.checkpointer = options?.checkpointer;
    this.options = {
      agentName: options?.agentName ?? 'lead',
      planMode: options?.planMode ?? false,
      subagentEnabled: options?.subagentEnabled ?? false,
      availableSkills: options?.availableSkills,
    };
  }

  resetAgent(): void {
    this.agent = null;
    this.agentConfigKey = null;
  }

  private ensureAgent(): void {
    const key = buildConfigKey(this.modelConfig, this.options);

    if (this.agent !== null && this.agentConfigKey === key) {
      return;
    }

    // cache miss → 重建
    const model = createChatModel(this.modelConfig);
    const provider = inferProvider(this.modelConfig);

    this.agent = createBaseAgent({
      model,
      tools: this.tools,
      systemPrompt: this.systemPrompt,
      checkpointer: this.checkpointer,
      provider,
    });

    this.agentConfigKey = key;
    console.log(`[DeerFlowClient] Agent created/rebuilt (name=${this.options.agentName})`);
  }

  /**
   * 向 agent 发送消息并以 ClientAgentEvent 异步生成器的形式返回事件流。
   */
  async *stream(
    message: string,
    threadId?: string,
    metadata?: Record<string, unknown>,
  ): ClientAgentEventStream {
    const effectiveThreadId = threadId ?? uuidv4();
    const agentId = this.options.agentName ?? 'lead';

    /** 内部辅助：构造 internal AgentEvent 并即时映射输出 */
    const emit = (event: AgentEvent) => toClientAgentEvent(event);

    // 1. 确保 agent 就绪
    this.ensureAgent();

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
      const input = {
        messages: [new HumanMessage(message)],
      };

      const config = {
        configurable: {
          thread_id: effectiveThreadId,
        },
      };

      // streamMode:
      //  - "messages": AI token / tool_call 分片
      //  - "updates":  节点 state delta，承载 ToolMessage
      const stream = await this.agent!.stream(input, {
        ...config,
        streamMode: ['messages', 'updates'],
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

      for await (const chunk of stream) {
        const [mode, payload] = chunk as [string, any];

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
