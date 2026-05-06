/**
 * LeadAgentHarness - Lead Agent 核心引擎
 *
 * 作为所有任务的入口和调度中心，Lead Agent 通过 ReAct 模式
 * 自主决定：直接回答、调用基础工具、或调度 Sub-agent。
 *
 * 核心特性：
 * - 组合 AgentHarness 提供标准化运行时
 * - 从 SubAgentRegistry 获取所有 Sub-agent Tool
 * - 通过 SubAgentDispatcher 在独立 Harness 中执行 Sub-agent
 * - 保持与现有 AgentEventStream 的兼容性
 */

import { AgentHarness } from "./agent-harness";
import { SubAgentRegistry } from "./sub-agent-registry";
import { SubAgentDispatcher } from "./sub-agent-dispatcher";
import { searchWebTool } from "../tools";
import { getCheckpointer } from "@/lib";
import {
  AgentEventStream,
  AgentEventType,
  createAgentEvent,
  LifecycleEvent,
  ErrorEvent,
  HumanResumeEvent,
} from "@/types/agent-event";
import { Command } from "@langchain/langgraph";
import {
  HarnessConfig,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_RECURSION_LIMIT,
} from "./types";

/**
 * Lead Agent 系统提示词
 *
 * 描述 Lead Agent 作为调度中心的角色，
 * 指导 LLM 何时直接回答、何时调度 Sub-agent。
 */
const LEAD_AGENT_SYSTEM_PROMPT = `你是一个智能深度研究助手的调度中心（Lead Agent）。你的职责是理解用户的研究需求，并通过调度专业的 Sub-agent 来完成复杂的研究任务。

## 你的工作流程

### 对于简单问题（如日常对话、简单查询）：
- 直接回答，无需调度 Sub-agent

### 对于需要深度研究的复杂问题：
你应该按照以下步骤进行：

1. **初步分析**：调用 sub_agent_simpleAnalyser，对用户问题进行初步分析，获取研究目标和开场白
2. **任务拆解**：调用 sub_agent_taskDecomposer，将研究目标拆解为可执行的子任务列表
3. **逐个执行子任务**：对每个子任务调用 sub_agent_taskHandler，获取处理结果
4. **生成报告**：当所有子任务完成后，调用 sub_agent_reportGenerator，将所有结果整合为最终研究报告

### 工具使用指南：
- **sub_agent_simpleAnalyser**：用于初步分析用户问题，生成研究目标和开场白
- **sub_agent_taskDecomposer**：用于将复杂问题拆解为子任务
- **sub_agent_taskHandler**：用于执行单个子任务（支持网络搜索）
- **sub_agent_reportGenerator**：用于整合所有子任务结果生成最终报告
- **search_web_tool**：用于直接搜索网络信息（简单搜索场景）

## 输出格式规范
- 所有数学公式使用 LaTeX 语法（$..$ 行内，$$...$$ 独立）
- 使用纯 Markdown 格式
- 不使用 HTML 标签
- 代码使用带语言标识的代码块

请根据用户问题的复杂度，灵活选择处理策略。`;

/**
 * LeadAgentHarness
 *
 * Lead Agent 核心引擎，组合 AgentHarness 并集成 Sub-agent 调度能力。
 */
export class LeadAgentHarness {
  private harness: AgentHarness;
  private registry: SubAgentRegistry;
  private dispatcher: SubAgentDispatcher;
  private checkpointer: any = null;

  constructor(config?: Partial<HarnessConfig>) {
    this.registry = SubAgentRegistry.getInstance();

    // 创建 SubAgentDispatcher
    this.dispatcher = new SubAgentDispatcher({
      parentContextId: "lead_agent",
      currentDepth: 0,
    });

    // 将 Dispatcher 的工具创建函数注入到 Registry
    this.registry.setToolFactory((subAgentConfig) =>
      this.dispatcher.createSubAgentTool(subAgentConfig),
    );

    // 合并基础工具和 Sub-agent Tool
    const baseTools = [searchWebTool];
    const subAgentTools = this.registry.toTools();
    const allTools = [...baseTools, ...subAgentTools];

    // 创建 AgentHarness
    this.harness = new AgentHarness({
      agentId: config?.agentId || "LeadAgent",
      systemPrompt: config?.systemPrompt || LEAD_AGENT_SYSTEM_PROMPT,
      model: config?.model || {
        name: "qwen",
model: "qwen3.6-plus",
      },
      tools: allTools,
      timeout: config?.timeout || 300_000, // Lead Agent 超时 5 分钟
      hooks: config?.hooks,
      maxIterations: config?.maxIterations || DEFAULT_MAX_ITERATIONS,
      recursionLimit: config?.recursionLimit || DEFAULT_RECURSION_LIMIT,
    });

    // 将 SubAgentDispatcher 关联到 AgentHarness，
    // 使得 harness.execute() 能消费 dispatcher 的 pendingEvents 队列
    this.harness.setSubAgentDispatcher(this.dispatcher);
  }

  /**
   * 初始化 Lead Agent
   *
   * 获取 checkpointer 并初始化 Harness
   */
  async initialize(): Promise<void> {
    this.checkpointer = await getCheckpointer();
    await this.harness.initialize();
  }

  /**
   * 创建消息流（兼容 BaseAgentServer 接口）
   *
   * @param messages - 消息数组
   * @param metadata - 元数据，包含 deepResearchId 和 isResume 标志
   * @returns AgentEventStream - 异步生成器，产生 AgentEvent
   */
  async *createMessage(
    messages: any[],
    metadata?: { [key: string]: any },
  ): AgentEventStream {
    try {
      // 确保已初始化
      if (!this.harness.getContext().lifecycle) {
        await this.initialize();
      }

      const { deepResearchId, isResume } = metadata || {};

      // 发射生命周期 start 事件
      yield createAgentEvent<LifecycleEvent>(
        AgentEventType.LIFECYCLE,
        this.harness.getConfig().agentId,
        { stage: "start", timestamp: Date.now() },
        { deepResearchId },
      );

      // 根据是否恢复模式选择不同的输入
      let input: any;
      if (isResume !== undefined) {
        // 恢复模式：发射 human_resume 事件
        yield createAgentEvent<HumanResumeEvent>(
          AgentEventType.HUMAN_RESUME,
          this.harness.getConfig().agentId,
          {
            decision: isResume ? "continue" : "re_decompose",
            resumeTarget: isResume ? "continue" : "re_decompose",
          },
          { deepResearchId },
        );

        input = new Command({
          resume: isResume ? "continue" : "re_decompose",
        });
      } else {
        // 正常模式：将用户消息作为输入
        // ReactAgent 期望 messages 为消息数组格式: [{ role: "human", content: "..." }]
        const userMessage = messages[0]?.content || messages[0] || "";
        input = { messages: [{ role: "human", content: userMessage }] };
      }

      // 使用 AgentHarness 执行
      yield* this.harness.execute(input, {
        configurable: {
          thread_id: deepResearchId,
        },
        metadata: { deepResearchId },
      });

      // 发射生命周期 done 事件
      yield createAgentEvent<LifecycleEvent>(
        AgentEventType.LIFECYCLE,
        this.harness.getConfig().agentId,
        { stage: "done", timestamp: Date.now() },
        { deepResearchId },
      );
    } catch (error: any) {
      yield createAgentEvent<ErrorEvent>(
        AgentEventType.ERROR,
        this.harness.getConfig().agentId,
        {
          errorCode: error.name || "UnknownError",
          errorMessage: error.message || "An error occurred in LeadAgentHarness",
          recoverable: false,
        },
      );
    }
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    await this.harness.cleanup();
  }

  /**
   * 获取内部 Harness 实例
   */
  getHarness(): AgentHarness {
    return this.harness;
  }

  /**
   * 获取 Sub-agent 注册表
   */
  getRegistry(): SubAgentRegistry {
    return this.registry;
  }

  /**
   * 获取 Sub-agent 调度器
   */
  getDispatcher(): SubAgentDispatcher {
    return this.dispatcher;
  }
}
