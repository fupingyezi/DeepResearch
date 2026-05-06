import { BaseAgentServer, AgentConfig } from "./BaseAgentServer";
import { createAgent, ReactAgent } from "langchain";
import { createChatModel } from "@deerflow-harness/models";
import {
  AgentEventStream,
  AgentEventType,
  createAgentEvent,
  ErrorEvent,
  LifecycleEvent,
} from "@/types/agentEvent";

/**
 * ChatAgentServer - 处理基础聊天对话的 Agent
 *
 * 使用 streamEvents API 获取事件流，通过 StreamProcessor 转换为统一 AgentEvent
 */
export class ChatAgentServer extends BaseAgentServer {
  private AgentInstance: ReactAgent | undefined;

  constructor(config: AgentConfig) {
    super(config, {
      streamMode: "events",
    });
    this.buildAgent();
  }

  async buildAgent() {
    const model = await createChatModel("qwen", {
      model: this.config.model,
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
      streaming: this.config.streaming,
    });
    this.AgentInstance = createAgent({
      model: model,
      systemPrompt: this.config.systemPrompt,
      tools: this.config.tools,
      checkpointer: this.config.checkpointer,
    });
    console.log("ChatAgentServer AgentInstance built");
  }

  /**
   * 创建消息流（v2 事件驱动）
   *
   * @param messages - 消息历史数组
   * @param metadata - 元数据，包含 sessionId 等信息
   * @returns AgentEventStream - 异步生成器，产生 AgentEvent
   */
  async *createMessage(
    messages: any[],
    metadata?: { [key: string]: any },
  ): AgentEventStream {
    try {
      if (!this.AgentInstance) {
        yield createAgentEvent<ErrorEvent>(
          AgentEventType.ERROR,
          this.getAgentId(),
          {
            errorCode: "AgentNotInitialized",
            errorMessage: "Chat agent instance is not initialized",
            recoverable: false,
          },
        );
        return;
      }

      const sessionId = metadata?.sessionId;

      // 发射生命周期 start 事件
      yield createAgentEvent<LifecycleEvent>(
        AgentEventType.LIFECYCLE,
        this.getAgentId(),
        { stage: "start", timestamp: Date.now() },
        { sessionId },
      );

      // 使用 StreamProcessor 处理 streamEvents
      yield* this.streamProcessor.processStreamEvents(
        this.AgentInstance,
        { messages },
        {
          configurable: { thread_id: sessionId },
          metadata: { sessionId, ...metadata },
        },
      );

      // 发射生命周期 done 事件
      yield createAgentEvent<LifecycleEvent>(
        AgentEventType.LIFECYCLE,
        this.getAgentId(),
        { stage: "done", timestamp: Date.now() },
        { sessionId },
      );
    } catch (error: any) {
      console.error("=== ChatAgentServer.createMessage 发生错误 ===");
      console.error("错误名称:", error.name);
      console.error("错误消息:", error.message);

      yield createAgentEvent<ErrorEvent>(
        AgentEventType.ERROR,
        this.getAgentId(),
        {
          errorCode: error.name || "UnknownError",
          errorMessage:
            error.message || "An error occurred during message processing",
          recoverable: false,
        },
      );
    }
  }
}
