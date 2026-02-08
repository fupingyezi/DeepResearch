import { ApiStream, ApiStreamChunk } from "@/types/transform/stream";
import { BaseAgentServer, AgentConfig } from "./BaseAgentServer";
import { createAgent, ReactAgent } from "langchain";
import { buildLLM } from "@/lib";

/**
 * ChatAgentServer - 处理基础聊天对话的 Agent 服务器
 */
export class ChatAgentServer extends BaseAgentServer {
  private AgentInstance: ReactAgent | undefined;

  constructor(config: AgentConfig) {
    super(config);
    this.buildAgent();
  }

  buildAgent() {
    const model = buildLLM("qwen", { model: "qwen-max" });
    this.AgentInstance = createAgent({
      model: model,
      ...this.getConfig(),
    });
  }

  /**
   * 创建消息流
   * @param systemPrompt - 系统提示词（可覆盖配置中的默认值）
   * @param messages - 消息历史数组
   * @param metadata - 元数据，包含 sessionId 等信息
   * @returns ApiStream - 异步生成器，产生 ApiStreamChunk
   */
  async *createMessage(
    systemPrompt: string,
    messages: any[],
    metadata?: { [key: string]: any },
  ): ApiStream {
    try {
      // 检查 Agent 是否已初始化
      if (!this.AgentInstance) {
        yield {
          type: "error",
          error: "AgentNotInitialized",
          message: "Chat agent instance is not initialized",
        } as ApiStreamChunk;
        return;
      }

      // 从 metadata 中提取 sessionId
      const sessionId = metadata?.sessionId;

      // 调用 Agent 的流式方法
      const stream = await this.AgentInstance.stream(
        { messages: messages },
        {
          streamMode: "messages",
          configurable: { thread_id: sessionId },
        },
      );

      // 转换流式输出为 ApiStreamChunk 格式
      for await (const chunk of stream) {
        if (chunk && chunk.length > 0) {
          const message = chunk[0];
          if (message.content) {
            yield {
              type: "text",
              text: message.content,
            } as ApiStreamChunk;
          }
        }
      }
    } catch (error: any) {
      // 错误处理
      yield {
        type: "error",
        error: error.name || "UnknownError",
        message: error.message || "An error occurred during message processing",
      } as ApiStreamChunk;
    }
  }
}
