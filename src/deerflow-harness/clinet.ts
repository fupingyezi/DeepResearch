import { v4 as uuidv4 } from 'uuid';
import { HumanMessage } from '@langchain/core/messages';
import { StructuredToolInterface } from '@langchain/core/tools';
import { BaseCheckpointSaver } from '@langchain/langgraph';

import { createChatModel } from './models';
import { createBaseAgent } from './agents/factory';
import { SYSTEM_PROMPT } from './agents/lead-agent';
import { searchWebTool } from './tools';
import { ModelConfig, ClientOptions, AgentConfigKey } from './types';
import {
  AgentEvent,
  AgentEventType,
  createAgentEvent,
  type AgentEventStream,
} from '@/types/agent-event';


function buildConfigKey(
  modelConfig: ModelConfig,
  opts: ClientOptions,
): AgentConfigKey {
  return JSON.stringify([
    modelConfig.modelName,
    opts.planMode ?? false,
    opts.subagentEnabled ?? false,
    opts.agentName ?? 'default',
    opts.availableSkills?.sort() ?? [],
  ]);
}


export class DeerFlowClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      return; // cache hit
    }

    // cache miss → 重建
    const model = createChatModel(this.modelConfig);

    this.agent = createBaseAgent({
      model,
      tools: this.tools,
      systemPrompt: this.systemPrompt,
      checkpointer: this.checkpointer,
    });

    this.agentConfigKey = key;
    console.log(
      `[DeerFlowClient] Agent created/rebuilt (name=${this.options.agentName})`,
    );
  }

  /**
   * 向 agent 发送消息并以 AgentEvent 异步生成器的形式返回事件流。
   *
   * 对应 Python client.py 的 stream() 方法：
   *  1. 构造 RunnableConfig
   *  2. _ensure_agent(config)
   *  3. self._agent.stream(state, config, stream_mode=["values","messages","custom"])
   *  4. 逐条转换成 StreamEvent yield 出去
   */
  async *stream(
    message: string,
    threadId?: string,
    metadata?: Record<string, unknown>,
  ): AgentEventStream {
    const effectiveThreadId = threadId ?? uuidv4();
    const agentId = this.options.agentName ?? 'lead';

    // 1. 确保 agent 就绪
    this.ensureAgent();

    // 2. 发送 lifecycle start
    yield createAgentEvent<AgentEvent>(
      AgentEventType.LIFECYCLE,
      agentId,
      { stage: 'start', timestamp: Date.now() },
      { sessionId: effectiveThreadId, ...metadata },
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

      // 4. 调用 agent.stream() — streamMode "messages" 提供逐 token 流
      const stream = await this.agent!.stream(input, {
        ...config,
        streamMode: 'messages',
      });

      for await (const [msgChunk, _metadata] of stream) {
        // msgChunk 是 BaseMessageChunk
        // AI message chunk → LLM_STREAM
        if (msgChunk._getType() === 'ai') {
          const content =
            typeof msgChunk.content === 'string'
              ? msgChunk.content
              : '';

          if (content) {
            yield createAgentEvent<AgentEvent>(
              AgentEventType.LLM_STREAM,
              agentId,
              { text: content },
              { sessionId: effectiveThreadId, ...metadata },
            );
          }

          // 检查 tool_calls（AI 发起工具调用）
          const toolCalls = (msgChunk as any).tool_calls;
          if (toolCalls && Array.isArray(toolCalls)) {
            for (const tc of toolCalls) {
              yield createAgentEvent<AgentEvent>(
                AgentEventType.TOOL_CALL_START,
                agentId,
                {
                  toolCallId: tc.id ?? '',
                  toolName: tc.name ?? '',
                  arguments: JSON.stringify(tc.args ?? {}),
                },
                { sessionId: effectiveThreadId, ...metadata },
              );
            }
          }
        }

        // Tool message → TOOL_CALL_RESULT
        if (msgChunk._getType() === 'tool') {
          yield createAgentEvent<AgentEvent>(
            AgentEventType.TOOL_CALL_RESULT,
            agentId,
            {
              toolCallId: (msgChunk as any).tool_call_id ?? '',
              toolName: (msgChunk as any).name ?? '',
              result: msgChunk.content,
              success: true,
            },
            { sessionId: effectiveThreadId, ...metadata },
          );
        }
      }

      // 5. LLM_COMPLETE
      yield createAgentEvent<AgentEvent>(
        AgentEventType.LLM_COMPLETE,
        agentId,
        {},
        { sessionId: effectiveThreadId, ...metadata },
      );
    } catch (error: any) {
      yield createAgentEvent<AgentEvent>(
        AgentEventType.ERROR,
        agentId,
        {
          errorCode: 'AGENT_STREAM_ERROR',
          errorMessage: error.message ?? 'Unknown error during stream',
          recoverable: false,
        },
        { sessionId: effectiveThreadId, ...metadata },
      );
    } finally {
      // 6. lifecycle done
      yield createAgentEvent<AgentEvent>(
        AgentEventType.LIFECYCLE,
        agentId,
        { stage: 'done', timestamp: Date.now() },
        { sessionId: effectiveThreadId, ...metadata },
      );
    }
  }
}
