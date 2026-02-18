import { ApiStream, ApiStreamChunk } from "@/types/transform/stream";
import { StreamChunkTransformer } from "@/lib/stream";
import { BaseAgentServer, AgentConfig } from "./BaseAgentServer";
import { createAgent, ReactAgent } from "langchain";
import { buildLLM } from "@/lib";

/**
 * ChatAgentServer - 处理基础聊天对话的 Agent
 */
export class ChatAgentServer extends BaseAgentServer {
  private AgentInstance: ReactAgent | undefined;

  constructor(config: AgentConfig) {
    super(config);
    this.buildAgent();
    this.transformer = new StreamChunkTransformer({
      enableToolCalls: true,
      enableUsageTracking: true,
      enableReasoning: false,
      enableGrounding: false,
      streamMode: "messages",
    });
  }

  buildAgent() {
    const model = buildLLM("qwen", this.config);
    this.AgentInstance = createAgent({
      model: model,
      systemPrompt: this.config.systemPrompt,
      tools: this.config.tools,
      checkpointer: this.config.checkpointer,
    });
    console.log("AgentInstance:", this.AgentInstance);
  }

  /**
   * 创建消息流
   * @param systemPrompt - 系统提示词（可覆盖配置中的默认值）
   * @param messages - 消息历史数组
   * @param metadata - 元数据，包含 sessionId 等信息
   * @returns ApiStream - 异步生成器，产生 ApiStreamChunk
   */
  async *createMessage(
    messages: any[],
    metadata?: { [key: string]: any },
  ): ApiStream {
    try {
      if (!this.AgentInstance) {
        yield {
          type: "error",
          error: "AgentNotInitialized",
          message: "Chat agent instance is not initialized",
        } as ApiStreamChunk;
        return;
      }

      const sessionId = metadata?.sessionId;

      const stream = await this.AgentInstance.stream(
        { messages: messages },
        {
          streamMode: "messages",
          configurable: { thread_id: sessionId },
        },
      );

      yield* this.transformer?.transformLangChainStream(stream, {
        sessionId,
        metadata,
      }) || [];
    } catch (error: any) {
      console.error("=== ChatAgentServer.createMessage 发生错误 ===");
      console.error("错误名称:", error.name);
      console.error("错误消息:", error.message);
      console.error("错误堆栈:", error.stack);

      yield {
        type: "error",
        error: error.name || "UnknownError",
        message: error.message || "An error occurred during message processing",
      } as ApiStreamChunk;
    }
  }
}
