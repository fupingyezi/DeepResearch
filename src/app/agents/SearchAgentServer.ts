import { ApiStream, ApiStreamChunk } from "@/types/transform/stream";
import { BaseAgentServer, AgentConfig } from "./BaseAgentServer";
import { createAgent, ReactAgent } from "langchain";
import { buildLLM } from "@/lib";
import { searchWebTool } from "./tools";

/**
 * SearchAgentServer - 处理带搜索工具的聊天对话的 Agent 服务器
 */
export class SearchAgentServer extends BaseAgentServer {
  private AgentInstance: ReactAgent | undefined;

  constructor(config: AgentConfig) {
    super(config);
    this.transformer = new (require("@/lib/stream").StreamChunkTransformer)({
      enableToolCalls: true,
      enableUsageTracking: true,
      enableReasoning: false,
      enableGrounding: true,
    });
    this.buildAgent();
  }

  buildAgent() {
    const model = buildLLM("qwen", { model: "qwen-flash" });
    this.AgentInstance = createAgent({
      model: model,
      tools: [searchWebTool],
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
      if (!this.AgentInstance) {
        yield {
          type: "error",
          error: "AgentNotInitialized",
          message: "Search agent instance is not initialized",
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

      yield* this.getTransformer().transformLangChainStream(stream, {
        sessionId,
        metadata,
      });
    } catch (error: any) {
      yield {
        type: "error",
        error: error.name || "UnknownError",
        message: error.message || "An error occurred during search processing",
      } as ApiStreamChunk;
    }
  }
}
