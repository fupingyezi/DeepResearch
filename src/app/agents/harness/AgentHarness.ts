/**
 * AgentHarness - Agent 运行时容器核心类
 *
 * 为每个 Agent（Lead 或 Sub-agent）提供标准化的执行环境：
 * - 标准化生命周期管理：initialize → execute → cleanup
 * - 上下文隔离：每个 Agent 运行在独立的上下文中
 * - 工具沙箱：仅允许配置中声明的工具
 * - 可观测性：自动采集执行指标和事件流
 * - 超时控制：AbortController + setTimeout 机制
 */

import { createAgent, ReactAgent } from "langchain";
import { buildLLM } from "@/lib";
import {
  AgentEvent,
  AgentEventType,
  AgentEventStream,
  createAgentEvent,
  ErrorEvent,
  HarnessLifecycleEvent,
} from "@/types/agentEvent";
import { StreamProcessor } from "../modules/StreamProcessor";
import { EventStreamAdapter } from "../eventStream/EventStreamAdapter";
import { AgentEventEmitter } from "../modules/AgentEventEmitter";
import {
  HarnessConfig,
  HarnessContext,
  HarnessLifecycle,
  HarnessExecutionResult,
  HarnessExecutionMetrics,
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_RECURSION_LIMIT,
} from "./types";
import { HooksManager } from "./HooksManager";

/**
 * AgentHarness - Agent 运行时容器
 *
 * 每个 Agent 实例都运行在一个 Harness 中，Harness 负责：
 * 1. 创建和管理 Agent 实例
 * 2. 提供独立的执行上下文
 * 3. 管理生命周期钩子
 * 4. 采集执行指标
 * 5. 超时控制
 */
export class AgentHarness {
  protected config: HarnessConfig;
  protected context: HarnessContext;
  protected agentInstance: ReactAgent | null = null;
  protected hooksManager: HooksManager;
  protected emitter: AgentEventEmitter;
  protected streamProcessor: StreamProcessor;
  protected abortController: AbortController | null = null;
  protected metrics: HarnessExecutionMetrics;

  constructor(config: HarnessConfig, parentContextId?: string, depth: number = 0) {
    this.config = config;
    this.hooksManager = new HooksManager();
    this.emitter = new AgentEventEmitter(config.agentId);
    this.streamProcessor = new StreamProcessor({
      agentId: config.agentId,
    });

    // 初始化独立的执行上下文
    this.context = {
      contextId: `harness_${config.agentId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      messages: [],
      state: {},
      metadata: { agentId: config.agentId },
      depth,
      parentContextId,
      lifecycle: HarnessLifecycle.INITIALIZE,
      createdAt: Date.now(),
    };

    // 初始化执行指标
    this.metrics = {
      durationMs: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      toolCallCount: 0,
      subAgentDispatchCount: 0,
    };

    // 注册配置中声明的 Hooks
    if (config.hooks) {
      for (const hook of config.hooks) {
        this.hooksManager.register(hook);
      }
    }
  }

  /**
   * 初始化阶段：创建 Agent 实例，绑定工具沙箱
   */
  async initialize(): Promise<void> {
    this.context.lifecycle = HarnessLifecycle.INITIALIZE;

    // 发射 Harness 生命周期事件
    this.emitHarnessLifecycle("initialize", "start");

    try {
      // 构建 LLM 实例
      const modelConfig = this.config.model || {
        provider: "qwen",
        model: "qwen-flash",
      };

      const model = buildLLM(modelConfig.provider as any, {
        model: modelConfig.model,
        maxTokens: modelConfig.maxTokens,
        temperature: modelConfig.temperature,
      });

      // 绑定工具沙箱：仅允许配置中声明的工具
      const tools = this.config.tools || [];

      // 如果有工具，绑定到模型上
      const boundModel = tools.length > 0 ? model.bindTools(tools) : model;

      // 创建 Agent 实例
      this.agentInstance = createAgent({
        model: boundModel,
        systemPrompt: this.config.systemPrompt,
        tools: tools.length > 0 ? tools : undefined,
      });

      this.emitHarnessLifecycle("initialize", "complete");
    } catch (error: any) {
      this.emitHarnessLifecycle("initialize", "error", error.message);
      throw error;
    }
  }

  /**
   * 执行阶段：运行 Agent 的 ReAct 循环
   *
   * @param input - 输入数据（字符串或消息数组）
   * @param options - 执行选项
   * @returns AgentEvent 异步生成器
   */
  async *execute(
    input: string | any,
    options?: {
      configurable?: Record<string, any>;
      metadata?: Record<string, any>;
    },
  ): AgentEventStream {
    if (!this.agentInstance) {
      yield createAgentEvent<ErrorEvent>(
        AgentEventType.ERROR,
        this.config.agentId,
        {
          errorCode: "HarnessNotInitialized",
          errorMessage: "AgentHarness has not been initialized. Call initialize() first.",
          recoverable: false,
        },
      );
      return;
    }

    this.context.lifecycle = HarnessLifecycle.EXECUTE;
    this.emitHarnessLifecycle("execute", "start");

    const startTime = Date.now();
    const timeout = this.config.timeout || DEFAULT_TIMEOUT;

    // 设置超时控制
    this.abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      this.abortController?.abort();
    }, timeout);

    try {
      // 执行 preExecute Hooks
      const hookResult = await this.hooksManager.runPreExecute(this.context);
      if (hookResult.abort) {
        yield createAgentEvent<ErrorEvent>(
          AgentEventType.ERROR,
          this.config.agentId,
          {
            errorCode: "HookAborted",
            errorMessage: `PreExecute hook aborted: ${hookResult.reason || "unknown reason"}`,
            recoverable: false,
          },
        );
        return;
      }
      // 更新上下文（Hook 可能修改了上下文）
      if (hookResult.data) {
        Object.assign(this.context, hookResult.data);
      }

      // 准备输入
      const agentInput = typeof input === "string"
        ? { messages: input }
        : input;

      // 使用 streamEvents 处理事件流
      const streamOptions = {
        version: "v2" as const,
        configurable: options?.configurable,
        recursionLimit: this.config.recursionLimit || DEFAULT_RECURSION_LIMIT,
        metadata: {
          ...options?.metadata,
          harnessId: this.context.contextId,
          depth: this.context.depth,
        },
        signal: this.abortController.signal,
      };

      const eventStream = this.agentInstance.streamEvents(agentInput, streamOptions);

      // 创建适配器处理事件流
      const adapter = new EventStreamAdapter({
        agentId: this.config.agentId,
        metadata: this.context.metadata,
      });

      for await (const agentEvent of adapter.adaptStreamEvents(eventStream)) {
        // 检查是否已超时
        if (this.abortController.signal.aborted) {
          yield createAgentEvent<ErrorEvent>(
            AgentEventType.ERROR,
            this.config.agentId,
            {
              errorCode: "ExecutionTimeout",
              errorMessage: `Agent execution timed out after ${timeout}ms`,
              recoverable: false,
            },
          );
          break;
        }

        // 采集执行指标
        this.collectMetrics(agentEvent);

        yield agentEvent;
      }

      // 执行 postExecute Hooks
      const executionResult: HarnessExecutionResult = {
        success: true,
        output: "",
        metrics: { ...this.metrics, durationMs: Date.now() - startTime },
      };
      await this.hooksManager.runPostExecute(executionResult);

      this.emitHarnessLifecycle("execute", "complete");
    } catch (error: any) {
      if (error.name === "AbortError" || this.abortController?.signal.aborted) {
        yield createAgentEvent<ErrorEvent>(
          AgentEventType.ERROR,
          this.config.agentId,
          {
            errorCode: "ExecutionTimeout",
            errorMessage: `Agent execution timed out after ${timeout}ms`,
            recoverable: false,
          },
        );
      } else {
        yield createAgentEvent<ErrorEvent>(
          AgentEventType.ERROR,
          this.config.agentId,
          {
            errorCode: error.name || "ExecutionError",
            errorMessage: error.message || "An error occurred during agent execution",
            recoverable: false,
          },
        );
      }
      this.emitHarnessLifecycle("execute", "error", error.message);
    } finally {
      clearTimeout(timeoutId);
      this.metrics.durationMs = Date.now() - startTime;
    }
  }

  /**
   * 清理阶段：释放资源，确保不泄漏到其他 Harness
   */
  async cleanup(): Promise<void> {
    this.context.lifecycle = HarnessLifecycle.CLEANUP;
    this.emitHarnessLifecycle("cleanup", "start");

    try {
      // 释放 Agent 实例
      this.agentInstance = null;

      // 清除上下文状态
      this.context.messages = [];
      this.context.state = {};

      // 取消可能仍在运行的操作
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }

      this.emitHarnessLifecycle("cleanup", "complete");
    } catch (error: any) {
      this.emitHarnessLifecycle("cleanup", "error", error.message);
    }
  }

  // ============================================================
  // 公共访问方法
  // ============================================================

  /** 获取 Harness 配置 */
  getConfig(): HarnessConfig {
    return { ...this.config };
  }

  /** 获取执行上下文 */
  getContext(): HarnessContext {
    return { ...this.context };
  }

  /** 获取执行指标 */
  getMetrics(): HarnessExecutionMetrics {
    return { ...this.metrics };
  }

  /** 获取 Hooks 管理器 */
  getHooksManager(): HooksManager {
    return this.hooksManager;
  }

  /** 获取事件发射器 */
  getEmitter(): AgentEventEmitter {
    return this.emitter;
  }

  // ============================================================
  // 私有方法
  // ============================================================

  /**
   * 发射 Harness 生命周期事件
   */
  private emitHarnessLifecycle(
    phase: "initialize" | "execute" | "cleanup",
    status: "start" | "complete" | "error",
    errorMessage?: string,
  ): void {
    const event = createAgentEvent<HarnessLifecycleEvent>(
      AgentEventType.HARNESS_LIFECYCLE,
      this.config.agentId,
      {
        harnessId: this.context.contextId,
        phase,
        status,
        depth: this.context.depth,
        timestamp: Date.now(),
        errorMessage,
      },
      this.context.metadata,
    );
    this.emitter.emit(event);
  }

  /**
   * 采集执行指标
   */
  private collectMetrics(event: AgentEvent): void {
    switch (event.eventType) {
      case AgentEventType.TOOL_CALL_START:
        this.metrics.toolCallCount++;
        break;
      case AgentEventType.LLM_COMPLETE:
        if (event.payload.usage) {
          this.metrics.tokenUsage.inputTokens += event.payload.usage.inputTokens;
          this.metrics.tokenUsage.outputTokens += event.payload.usage.outputTokens;
          if (event.payload.usage.reasoningTokens) {
            this.metrics.tokenUsage.reasoningTokens =
              (this.metrics.tokenUsage.reasoningTokens || 0) +
              event.payload.usage.reasoningTokens;
          }
        }
        break;
      case AgentEventType.SUB_AGENT_DISPATCH:
        if (event.payload.status === "dispatched") {
          this.metrics.subAgentDispatchCount++;
        }
        break;
    }
  }
}
