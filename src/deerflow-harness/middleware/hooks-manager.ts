/**
 * HooksManager - Hooks 生命周期钩子管理器
 *
 * 管理 Agent Harness 的四种生命周期钩子：
 * - preExecute: Agent 执行前
 * - preToolUse: 工具调用前
 * - postToolUse: 工具调用后
 * - postExecute: Agent 执行后
 *
 * 支持按优先级排序执行、作用范围过滤、错误处理策略。
 */

import { HarnessContext, HarnessExecutionResult, MAX_HOOKS_CHAIN_DEPTH } from "../agents/types";
import {
  HarnessHook,
  HookPhase,
  HookScope,
  HookFailureStrategy,
  HookResult,
  ToolCallInfo,
  ToolResultInfo,
  PreExecuteHook,
  PreToolUseHook,
  PostToolUseHook,
  PostExecuteHook,
  AnyHarnessHook,
} from "./hooks";

/**
 * HooksManager
 *
 * 维护四个 Hook 队列，按优先级排序执行。
 * 支持 Hook 修改输入/输出或返回 abort 信号中断执行。
 */
export class HooksManager {
  /** preExecute Hook 队列 */
  private preExecuteHooks: PreExecuteHook[] = [];
  /** preToolUse Hook 队列 */
  private preToolUseHooks: PreToolUseHook[] = [];
  /** postToolUse Hook 队列 */
  private postToolUseHooks: PostToolUseHook[] = [];
  /** postExecute Hook 队列 */
  private postExecuteHooks: PostExecuteHook[] = [];

  /**
   * 注册一个 Hook
   *
   * 根据 Hook 的 phase 注册到对应队列，并按 priority 排序
   */
  register(hook: HarnessHook): void {
    switch (hook.phase) {
      case HookPhase.PRE_EXECUTE:
        this.preExecuteHooks.push(hook as PreExecuteHook);
        this.preExecuteHooks.sort((a, b) => a.priority - b.priority);
        break;
      case HookPhase.PRE_TOOL_USE:
        this.preToolUseHooks.push(hook as PreToolUseHook);
        this.preToolUseHooks.sort((a, b) => a.priority - b.priority);
        break;
      case HookPhase.POST_TOOL_USE:
        this.postToolUseHooks.push(hook as PostToolUseHook);
        this.postToolUseHooks.sort((a, b) => a.priority - b.priority);
        break;
      case HookPhase.POST_EXECUTE:
        this.postExecuteHooks.push(hook as PostExecuteHook);
        this.postExecuteHooks.sort((a, b) => a.priority - b.priority);
        break;
    }
  }

  /**
   * 注销一个 Hook（按名称）
   */
  unregister(hookName: string): void {
    this.preExecuteHooks = this.preExecuteHooks.filter((h) => h.name !== hookName);
    this.preToolUseHooks = this.preToolUseHooks.filter((h) => h.name !== hookName);
    this.postToolUseHooks = this.postToolUseHooks.filter((h) => h.name !== hookName);
    this.postExecuteHooks = this.postExecuteHooks.filter((h) => h.name !== hookName);
  }

  /**
   * 执行 preExecute Hook 链
   *
   * @param context 当前 Harness 上下文
   * @returns Hook 执行结果（可能包含修改后的上下文或 abort 信号）
   */
  async runPreExecute(context: HarnessContext): Promise<HookResult<HarnessContext>> {
    return this.runHookChain<HarnessContext, PreExecuteHook>(
      this.preExecuteHooks,
      context,
      "preExecute",
    );
  }

  /**
   * 执行 preToolUse Hook 链
   *
   * @param toolCall 工具调用信息
   * @returns Hook 执行结果（可能包含修改后的工具调用信息或 abort 信号）
   */
  async runPreToolUse(toolCall: ToolCallInfo): Promise<HookResult<ToolCallInfo>> {
    return this.runHookChain<ToolCallInfo, PreToolUseHook>(
      this.preToolUseHooks,
      toolCall,
      "preToolUse",
    );
  }

  /**
   * 执行 postToolUse Hook 链
   *
   * @param toolResult 工具调用结果信息
   * @returns Hook 执行结果（可能包含修改后的工具结果或 abort 信号）
   */
  async runPostToolUse(toolResult: ToolResultInfo): Promise<HookResult<ToolResultInfo>> {
    return this.runHookChain<ToolResultInfo, PostToolUseHook>(
      this.postToolUseHooks,
      toolResult,
      "postToolUse",
    );
  }

  /**
   * 执行 postExecute Hook 链
   *
   * @param result 执行结果
   * @returns Hook 执行结果（可能包含修改后的执行结果或 abort 信号）
   */
  async runPostExecute(result: HarnessExecutionResult): Promise<HookResult<HarnessExecutionResult>> {
    return this.runHookChain<HarnessExecutionResult, PostExecuteHook>(
      this.postExecuteHooks,
      result,
      "postExecute",
    );
  }

  /**
   * 获取所有已注册的 Hook 数量
   */
  getHookCount(): number {
    return (
      this.preExecuteHooks.length +
      this.preToolUseHooks.length +
      this.postToolUseHooks.length +
      this.postExecuteHooks.length
    );
  }

  /**
   * 清除所有 Hook
   */
  clear(): void {
    this.preExecuteHooks = [];
    this.preToolUseHooks = [];
    this.postToolUseHooks = [];
    this.postExecuteHooks = [];
  }

  /**
   * 通用 Hook 链执行器
   *
   * 按优先级顺序执行 Hook 链，支持：
   * - Hook 修改输入/输出
   * - abort 信号中断执行
   * - 错误处理策略（skip / abort）
   * - 最大深度限制
   */
  private async runHookChain<TData, THook extends AnyHarnessHook>(
    hooks: THook[],
    initialData: TData,
    phaseName: string,
  ): Promise<HookResult<TData>> {
    if (hooks.length === 0) {
      return { abort: false, data: initialData };
    }

    // Hook 链最大深度限制
    if (hooks.length > MAX_HOOKS_CHAIN_DEPTH) {
      console.warn(
        `[HooksManager] ${phaseName} hook chain exceeds max depth (${MAX_HOOKS_CHAIN_DEPTH}), truncating.`,
      );
    }

    let currentData = initialData;
    const hooksToRun = hooks.slice(0, MAX_HOOKS_CHAIN_DEPTH);

    for (const hook of hooksToRun) {
      try {
        const result = await (hook as any).execute(currentData);

        // 如果 Hook 返回 abort 信号，中断整个链
        if (result.abort) {
          console.log(
            `[HooksManager] ${phaseName} hook "${hook.name}" aborted execution: ${result.reason || "no reason"}`,
          );
          return {
            abort: true,
            reason: result.reason || `Aborted by hook: ${hook.name}`,
          };
        }

        // 如果 Hook 返回了修改后的数据，更新当前数据
        if (result.data !== undefined) {
          currentData = result.data;
        }
      } catch (error: any) {
        console.error(
          `[HooksManager] ${phaseName} hook "${hook.name}" failed:`,
          error.message,
        );

        // 根据 Hook 的 onFailure 策略决定行为
        if (hook.onFailure === HookFailureStrategy.ABORT) {
          return {
            abort: true,
            reason: `Hook "${hook.name}" failed: ${error.message}`,
          };
        }

        // HookFailureStrategy.SKIP: 跳过此 Hook，继续执行下一个
        console.warn(
          `[HooksManager] Skipping failed hook "${hook.name}" (onFailure=skip)`,
        );
      }
    }

    return { abort: false, data: currentData };
  }
}
