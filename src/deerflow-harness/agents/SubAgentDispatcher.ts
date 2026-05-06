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
import {
  AgentEvent,
  AgentEventType,
  createAgentEvent,
  StateUpdateEvent,
  TaskProgressEvent,
} from "@/types/agentEvent";

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
  /** 待转发的事件队列（当 dispatchCustomEvent 不可用时暂存事件） */
  private pendingEvents: AgentEvent[] = [];

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
   * 获取并清空待转发的事件队列
   *
   * 当 dispatchCustomEvent 在 Tool 执行上下文中不可用时，
   * 事件会被暂存到 pendingEvents 队列中。
   * 外部（如 AgentHarness.execute()）可以调用此方法获取这些事件并注入到父事件流中。
   *
   * @returns 待转发的事件数组
   */
  flushPendingEvents(): AgentEvent[] {
    const events = [...this.pendingEvents];
    this.pendingEvents = [];
    return events;
  }

  /**
   * 检查是否有待转发的事件
   */
  hasPendingEvents(): boolean {
    return this.pendingEvents.length > 0;
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
   * 执行完成后，根据 Sub-agent 类型发射相应的 state_update / task_progress 事件，
   * 以便前端能够接收到深度研究的进度和结果。
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

      // 根据 Sub-agent 类型发射前端需要的自定义事件
      await this.emitSubAgentResultEvent(config.name, task, result);

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
   * 根据 Sub-agent 类型发射对应的 state_update / task_progress 自定义事件
   *
   * 这些事件会被 Lead Agent 的 streamEvents 捕获，
   * 经过 EventStreamAdapter 转换后传递给前端。
   */
  private async emitSubAgentResultEvent(
    subAgentName: string,
    task: string,
    result: string,
  ): Promise<void> {
    try {
      switch (subAgentName) {
        case "simpleAnalyser": {
          // 解析 simpleAnalyser 的 JSON 输出
          let parsed: { researchTarget?: string; simpleAnalysis?: string } = {};
          try {
            parsed = JSON.parse(result);
          } catch {
            // 如果解析失败，尝试提取 JSON 部分
            const jsonMatch = result.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              try {
                parsed = JSON.parse(jsonMatch[0]);
              } catch {
                parsed = { researchTarget: "", simpleAnalysis: result };
              }
            } else {
              parsed = { researchTarget: "", simpleAnalysis: result };
            }
          }
          const simpleAnalysisPayload = {
            stateType: "simple_analysis" as const,
            data: {
              researchTarget: parsed.researchTarget || "",
              simpleAnalysis: parsed.simpleAnalysis || "",
            },
          };
          try {
            await dispatchCustomEvent("state_update", simpleAnalysisPayload);
            console.log(`[SubAgentDispatcher] ✅ dispatchCustomEvent 成功: state_update/simple_analysis`);
          } catch (dispatchError: any) {
            console.warn(
              `[SubAgentDispatcher] ⚠️ dispatchCustomEvent 失败 (${subAgentName}/state_update/simple_analysis): ${dispatchError.message}. 事件将通过 pendingEvents 队列转发。`,
            );
            this.pendingEvents.push(
              createAgentEvent<StateUpdateEvent>(
                AgentEventType.STATE_UPDATE,
                this.parentContextId,
                simpleAnalysisPayload,
              ),
            );
          }
          break;
        }

        case "taskDecomposer": {
          // 解析 taskDecomposer 的 JSON 输出
          let tasks: any[] = [];
          try {
            const parsed = JSON.parse(result);
            tasks = parsed.tasks || parsed;
          } catch {
            const jsonMatch = result.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              try {
                const parsed = JSON.parse(jsonMatch[0]);
                tasks = parsed.tasks || [];
              } catch {
                tasks = [];
              }
            }
          }
          const tasksInitialPayload = {
            stateType: "tasks_initial" as const,
            data: tasks,
          };
          try {
            await dispatchCustomEvent("state_update", tasksInitialPayload);
            console.log(`[SubAgentDispatcher] ✅ dispatchCustomEvent 成功: state_update/tasks_initial`);
          } catch (dispatchError: any) {
            console.warn(
              `[SubAgentDispatcher] ⚠️ dispatchCustomEvent 失败 (${subAgentName}/state_update/tasks_initial): ${dispatchError.message}. 事件将通过 pendingEvents 队列转发。`,
            );
            this.pendingEvents.push(
              createAgentEvent<StateUpdateEvent>(
                AgentEventType.STATE_UPDATE,
                this.parentContextId,
                tasksInitialPayload,
              ),
            );
          }
          break;
        }

        case "taskHandler": {
          // 从 task 输入中提取 taskId
          // 支持多种格式：JSON 中的 taskId 字段、"taskId: xxx" 格式、"#N" 格式
          let taskId = "";
          try {
            // 优先尝试 JSON 解析
            const taskJson = JSON.parse(task);
            if (taskJson.taskId) {
              taskId = String(taskJson.taskId);
            }
          } catch {
            // 非 JSON 格式，尝试正则匹配
            try {
              const taskIdMatch = task.match(/taskId[:\s]*["']?([^"'\s,}]+)/i);
              if (taskIdMatch) {
                taskId = taskIdMatch[1];
              } else {
                // 尝试匹配 "#N" 或 "任务N" 格式
                const numMatch = task.match(/(?:#|任务|task\s*)([\d]+)/i);
                if (numMatch) {
                  taskId = numMatch[1];
                }
              }
            } catch {
              // 忽略解析错误
            }
          }
          const taskProgressPayload = {
            taskId: taskId,
            description: task,
            status: "done" as const,
            result: result,
          };
          try {
            await dispatchCustomEvent("task_progress", taskProgressPayload);
            console.log(`[SubAgentDispatcher] ✅ dispatchCustomEvent 成功: task_progress (taskId: ${taskId})`);
          } catch (dispatchError: any) {
            console.warn(
              `[SubAgentDispatcher] ⚠️ dispatchCustomEvent 失败 (${subAgentName}/task_progress): ${dispatchError.message}. 事件将通过 pendingEvents 队列转发。`,
            );
            this.pendingEvents.push(
              createAgentEvent<TaskProgressEvent>(
                AgentEventType.TASK_PROGRESS,
                this.parentContextId,
                taskProgressPayload,
              ),
            );
          }
          break;
        }

        case "reportGenerator": {
          const reportPayload = {
            stateType: "report" as const,
            data: result,
          };
          try {
            await dispatchCustomEvent("state_update", reportPayload);
            console.log(`[SubAgentDispatcher] ✅ dispatchCustomEvent 成功: state_update/report`);
          } catch (dispatchError: any) {
            console.warn(
              `[SubAgentDispatcher] ⚠️ dispatchCustomEvent 失败 (${subAgentName}/state_update/report): ${dispatchError.message}. 事件将通过 pendingEvents 队列转发。`,
            );
            this.pendingEvents.push(
              createAgentEvent<StateUpdateEvent>(
                AgentEventType.STATE_UPDATE,
                this.parentContextId,
                reportPayload,
              ),
            );
          }
          break;
        }

        default:
          // 其他未知的 Sub-agent，不发射额外事件
          break;
      }
    } catch (outerError: any) {
      // 外层 catch 仅捕获非 dispatchCustomEvent 的意外错误（如 JSON 解析异常等）
      console.error(
        `[SubAgentDispatcher] ❌ emitSubAgentResultEvent 意外错误 (${subAgentName}): ${outerError.message}`,
      );
    }
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
    } catch (dispatchError: any) {
      // dispatchCustomEvent 可能在非 LangGraph 上下文中失败
      // sub_agent_dispatch 事件为辅助调试事件，失败时仅记录警告，不推入 pendingEvents
      console.warn(
        `[SubAgentDispatcher] ⚠️ emitDispatchEvent 失败 (${subAgentName}/${status}): ${dispatchError.message}`,
      );
    }
  }
}
