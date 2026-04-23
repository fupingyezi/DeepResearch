import { Command } from "@langchain/langgraph";
import { BaseAgentServer, AgentConfig } from "./BaseAgentServer";
import {
  AgentEventStream,
  AgentEventType,
  createAgentEvent,
  ErrorEvent,
  LifecycleEvent,
  HumanResumeEvent,
} from "@/types/agentEvent";
import {
  createDeepResearchWorkflow,
  DEEP_RESEARCH_NODE_NAMES,
} from "./deepResearchWrokFlow";

/**
 * DeepResearchAgentServer - 处理深度研究工作流的 Agent
 *
 * 使用 streamEvents API 获取事件流，通过 StreamProcessor 自动捕获
 * 每个节点的进入/退出事件、LLM 流式输出、自定义事件等。
 */
export class DeepResearchAgentServer extends BaseAgentServer {
  private AgentInstance: any;

  constructor(config: AgentConfig) {
    super(config, {
      useStateGraph: true,
      streamMode: "events",
      workflowNodeNames: DEEP_RESEARCH_NODE_NAMES,
    });
  }

  /**
   * 构建 Agent 实例（异步）
   */
  async buildAgent() {
    this.AgentInstance = await createDeepResearchWorkflow();
  }

  /**
   * 创建消息流（v2 事件驱动）
   *
   * @param _messages - 消息数组
   * @param metadata - 元数据，包含 deepResearchId 和 isResume 标志
   * @returns AgentEventStream - 异步生成器，产生 AgentEvent
   */
  async *createMessage(
    _messages: any[],
    metadata?: { [key: string]: any },
  ): AgentEventStream {
    try {
      if (!this.AgentInstance) {
        await this.buildAgent();
      }

      if (!this.AgentInstance) {
        yield createAgentEvent<ErrorEvent>(
          AgentEventType.ERROR,
          this.getAgentId(),
          {
            errorCode: "AgentNotInitialized",
            errorMessage:
              "Deep research agent instance failed to initialize",
            recoverable: false,
          },
        );
        return;
      }

      const { deepResearchId, isResume } = metadata || {};

      // 发射生命周期 start 事件
      yield createAgentEvent<LifecycleEvent>(
        AgentEventType.LIFECYCLE,
        this.getAgentId(),
        { stage: "start", timestamp: Date.now() },
        { deepResearchId },
      );

      // 根据是否恢复模式选择不同的输入
      let input: any;
      if (isResume !== undefined) {
        // 恢复模式：发射 human_resume 事件
        yield createAgentEvent<HumanResumeEvent>(
          AgentEventType.HUMAN_RESUME,
          this.getAgentId(),
          {
            decision: isResume ? "supervisor" : "taskDecomposer",
            resumeTarget: isResume ? "supervisor" : "taskDecomposer",
          },
          { deepResearchId },
        );

        input = new Command({
          resume: isResume ? "supervisor" : "taskDecomposer",
        });
      } else {
        input = {
          input: _messages[0].content,
          simpleAnalysis: "",
          messages: [],
          tasks: [],
          nextAction: "",
          report: "",
          needsHumanReview: false,
        };
      }

      // 使用 StreamProcessor 处理 streamEvents
      yield* this.streamProcessor.processStreamEvents(
        this.AgentInstance,
        input,
        {
          configurable: { thread_id: deepResearchId },
          recursionLimit: 200,
          metadata: { deepResearchId },
        },
      );

      // 发射生命周期 done 事件
      yield createAgentEvent<LifecycleEvent>(
        AgentEventType.LIFECYCLE,
        this.getAgentId(),
        { stage: "done", timestamp: Date.now() },
        { deepResearchId },
      );
    } catch (error: any) {
      // 错误处理
      yield createAgentEvent<ErrorEvent>(
        AgentEventType.ERROR,
        this.getAgentId(),
        {
          errorCode: error.name || "UnknownError",
          errorMessage:
            error.message ||
            "An error occurred during research workflow",
          recoverable: false,
        },
      );
    }
  }
}
