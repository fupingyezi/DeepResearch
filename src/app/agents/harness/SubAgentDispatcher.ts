/**
 * SubAgentDispatcher - Sub-agent 工具化调度器
 *
 * 负责将 Sub-agent 配置包装为 LangChain Tool，
 * 当 Lead Agent 通过 function calling 调用 Sub-agent Tool 时，
 * Dispatcher 会在独立的 Harness 中实例化并执行 Sub-agent。
 *
 * 核心功能：
 * - 为每个 Sub-agent 创建 DynamicStructuredTool
 * - 在独立 Harness 中执行 Sub-agent
 * - 并发控制（信号量机制）
 * - 嵌套深度限制
 * - 事件流转发
 */

import { tool } from "langchain";
import z from "zod";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { AgentHarness } from "./AgentHarness";
import { SubAgentConfig } from "./subagent";
import {
  MAX_NESTING_DEPTH,
  MAX_CONCURRENT_SUB_AGENTS,
} from "./types";

/**
 * 简单信号量实现，用于并发控制
 */
class Semaphore {
  private permits: number;
  private waitQueue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      next();
    } else {
      this.permits++;
    }
  }
}

/**
 * SubAgentDispatcher
 *
 * 将 Sub-agent 配置转换为可被 Lead Agent 调用的 Tool，
 * 并在调用时自动创建独立 Harness 执行 Sub-agent。
 */
export class SubAgentDispatcher {
  /** 并发控制信号量 */
  private semaphore: Semaphore;
  /** 父 Harness 的上下文 ID */
  private parentContextId: string;
  /** 当前嵌套深度 */
  private currentDepth: number;
  /** 事件收集回调（用于将 Sub-agent 事件转发到父事件流） */
  private onSubAgentEvent?: (event: any) => void;

  constructor(options: {
    parentContextId: string;
    currentDepth: number;
    maxConcurrent?: number;
    onSubAgentEvent?: (event: any) => void;
  }) {
    this.parentContextId = options.parentContextId;
    this.currentDepth = options.currentDepth;
    this.semaphore = new Semaphore(options.maxConcurrent || MAX_CONCURRENT_SUB_AGENTS);
    this.onSubAgentEvent = options.onSubAgentEvent;
  }

  /**
   * 为单个 Sub-agent 配置创建 LangChain Tool
   *
   * 返回的 Tool 在被 Lead Agent 调用时，会：
   * 1. 创建一个新的 AgentHarness 实例
   * 2. 调用 harness.initialize() → harness.execute(task) → harness.cleanup()
   * 3. 收集事件并转发到父事件流
   * 4. 将最终文本输出作为 Tool Result 返回
   */
  createSubAgentTool(config: SubAgentConfig): any {
    const dispatcher = this;

    return tool(
      async (input: { task: string }) => {
        return dispatcher.executeSubAgent(config, input.task);
      },
      {
        name: `sub_agent_${config.name}`,
        description: config.description,
        schema: z.object({
          task: z.string().describe("要分配给此 Sub-agent 的任务描述"),
        }),
      },
    );
  }

  /**
   * 执行 Sub-agent
   *
   * 在独立的 Harness 中实例化并执行 Sub-agent，
   * 收集执行过程中的事件并转发到父事件流。
   */
  private async executeSubAgent(
    config: SubAgentConfig,
    task: string,
  ): Promise<string> {
    // 检查嵌套深度限制
    const subAgentDepth = this.currentDepth + 1;
    if (subAgentDepth > MAX_NESTING_DEPTH) {
      return `[Error] Sub-agent nesting depth exceeded (max: ${MAX_NESTING_DEPTH}). Cannot create sub-agent "${config.name}".`;
    }

    // 发射 SUB_AGENT_DISPATCH 事件（dispatched）
    await this.emitDispatchEvent(config.name, task, "dispatched");

    // 获取并发许可
    await this.semaphore.acquire();

    const startTime = Date.now();
    let result = "";

    try {
      // 发射 SUB_AGENT_DISPATCH 事件（running）
      await this.emitDispatchEvent(config.name, task, "running");

      // 创建独立的 Harness 实例
      const harness = new AgentHarness(
        {
          agentId: `sub_${config.name}_${Date.now()}`,
          systemPrompt: config.systemPrompt,
          model: config.model,
          tools: config.tools,
          timeout: config.timeout,
          hooks: config.hooks,
        },
        this.parentContextId,
        subAgentDepth,
      );

      // 生命周期：initialize → execute → cleanup
      await harness.initialize();

      // 收集 Sub-agent 的输出
      const outputParts: string[] = [];

      for await (const event of harness.execute(task)) {
        // 转发事件到父事件流
        if (this.onSubAgentEvent) {
          this.onSubAgentEvent(event);
        }

        // 收集 LLM 流式输出文本
        if (event.eventType === "llm_stream" && event.payload.text) {
          outputParts.push(event.payload.text);
        }
      }

      await harness.cleanup();

      result = outputParts.join("") || "[Sub-agent completed with no text output]";

      // 发射 SUB_AGENT_DISPATCH 事件（completed）
      const durationMs = Date.now() - startTime;
      await this.emitDispatchEvent(config.name, task, "completed", result, undefined, durationMs);

    } catch (error: any) {
      result = `[Error] Sub-agent "${config.name}" failed: ${error.message}`;

      // 发射 SUB_AGENT_DISPATCH 事件（failed）
      const durationMs = Date.now() - startTime;
      await this.emitDispatchEvent(config.name, task, "failed", undefined, error.message, durationMs);
    } finally {
      // 释放并发许可
      this.semaphore.release();
    }

    return result;
  }

  /**
   * 发射 sub_agent_dispatch 自定义事件
   */
  private async emitDispatchEvent(
    subAgentName: string,
    task: string,
    status: "dispatched" | "running" | "completed" | "failed",
    result?: string,
    errorMessage?: string,
    durationMs?: number,
  ): Promise<void> {
    try {
      await dispatchCustomEvent("sub_agent_dispatch", {
        subAgentName,
        task,
        status,
        result,
        errorMessage,
        durationMs,
      });
    } catch {
      // dispatchCustomEvent 可能在非 LangGraph 上下文中失败，静默忽略
      console.debug(
        `[SubAgentDispatcher] Could not dispatch event for ${subAgentName} (${status})`,
      );
    }
  }
}
