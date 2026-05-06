import { BaseAgentServer, AgentConfig } from "./base-agent-server";
import {
  AgentEventStream,
  AgentEventType,
  createAgentEvent,
  ErrorEvent,
} from "@/types/agent-event";
import { LeadAgentHarness } from "@deerflow-harness/agents";
import { loadAllSubAgents } from "@deerflow-harness/config";

/**
 * DeepResearchAgentServer - 处理深度研究工作流的 Agent
 *
 * 基于 Harness 架构重构：
 * - 内部使用 LeadAgentHarness 替代 StateGraph 固定图
 * - Lead Agent 通过 function calling 自主调度 Sub-agent
 * - 保持 createMessage() 方法签名和返回类型不变
 */
export class DeepResearchAgentServer extends BaseAgentServer {
  private leadAgent: LeadAgentHarness | null = null;
  private initialized = false;

  constructor(config: AgentConfig) {
    super(config, {
      useStateGraph: false,
      streamMode: "events",
    });
  }

  /**
   * 构建 Agent 实例（异步）
   *
   * 加载所有 Sub-agent 配置并初始化 LeadAgentHarness
   */
  async buildAgent() {
    // 加载所有 Sub-agent 配置到注册表
    loadAllSubAgents();

    // 创建并初始化 LeadAgentHarness
    this.leadAgent = new LeadAgentHarness({
      agentId: this.getAgentId(),
      systemPrompt: this.config.systemPrompt,
    });

    await this.leadAgent.initialize();
    this.initialized = true;
  }

  /**
   * 创建消息流（v2 事件驱动）
   *
   * 委托给 LeadAgentHarness.createMessage()，
   * 保持方法签名和返回类型（AgentEventStream）不变。
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
      // 确保已初始化
      if (!this.initialized || !this.leadAgent) {
        await this.buildAgent();
      }

      if (!this.leadAgent) {
        yield createAgentEvent<ErrorEvent>(
          AgentEventType.ERROR,
          this.getAgentId(),
          {
            errorCode: "AgentNotInitialized",
            errorMessage: "LeadAgentHarness failed to initialize",
            recoverable: false,
          },
        );
        return;
      }

      // 委托给 LeadAgentHarness
      yield* this.leadAgent.createMessage(_messages, metadata);
    } catch (error: any) {
      yield createAgentEvent<ErrorEvent>(
        AgentEventType.ERROR,
        this.getAgentId(),
        {
          errorCode: error.name || "UnknownError",
          errorMessage:
            error.message || "An error occurred during research workflow",
          recoverable: false,
        },
      );
    }
  }
}
