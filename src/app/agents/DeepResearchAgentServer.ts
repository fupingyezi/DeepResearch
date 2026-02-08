import { Command } from "@langchain/langgraph";
import { AgentConfig, BaseAgentServer } from "./BaseAgentServer";
import { ApiStream, ApiStreamChunk } from "@/types/transform/stream";
import { createDeepResearchWorkflow } from "./deepResearchWrokFlow";
import { handleStateUpdate } from "@/utils/handleStateUpdate";

/**
 * DeepResearchAgentServer - 处理深度研究工作流的 Agent 服务器
 */
export class DeepResearchAgentServer extends BaseAgentServer {
  private AgentInstance: any;

  constructor(config: AgentConfig) {
    super(config);
  }

  /**
   * 构建 Agent 实例（异步）
   */
  async buildAgent() {
    this.AgentInstance = await createDeepResearchWorkflow();
  }

  /**
   * 创建消息流
   * @param systemPrompt - 研究输入/问题
   * @param messages - 消息数组（可能不使用，工作流自己管理状态）
   * @param metadata - 元数据，包含 deepResearchId 和 isResume 标志
   * @returns ApiStream - 异步生成器，产生 ApiStreamChunk
   */
  async *createMessage(
    systemPrompt: string,
    _messages: any[],
    metadata?: { [key: string]: any },
  ): ApiStream {
    try {
      if (!this.AgentInstance) {
        await this.buildAgent();
      }

      if (!this.AgentInstance) {
        yield {
          type: "error",
          error: "AgentNotInitialized",
          message: "Deep research agent instance failed to initialize",
        } as ApiStreamChunk;
        return;
      }

      const { deepResearchId, isResume } = metadata || {};

      // 根据是否恢复模式选择不同的输入
      let streamPromise;
      if (isResume !== undefined) {
        streamPromise = this.AgentInstance.stream(
          new Command({ resume: isResume ? "supervisor" : "taskDecomposer" }),
          {
            configurable: { thread_id: deepResearchId },
            streamMode: "values",
            recursionLimit: 200,
          },
        );
      } else {
        streamPromise = this.AgentInstance.stream(
          {
            input: systemPrompt,
            simpleAnalysis: "",
            messages: [],
            tasks: [],
            nextAction: "",
            report: "",
            needsHumanReview: false,
          },
          {
            configurable: { thread_id: deepResearchId },
            streamMode: "values",
            recursionLimit: 200,
          },
        );
      }

      // 处理工作流状态更新
      let lastState: any = null;
      for await (const state of await streamPromise) {
        const updateState = handleStateUpdate(lastState, state);
        if (updateState) {
          // 将状态更新转换为文本格式
          yield {
            type: "text",
            text: JSON.stringify(updateState),
          } as ApiStreamChunk;
          lastState = state;
        }
      }
    } catch (error: any) {
      // 错误处理
      yield {
        type: "error",
        error: error.name || "UnknownError",
        message: error.message || "An error occurred during research workflow",
      } as ApiStreamChunk;
    }
  }
}
