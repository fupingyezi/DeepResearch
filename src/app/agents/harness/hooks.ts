/**
 * Harness Hooks 生命周期钩子类型定义
 *
 * 定义 Agent Harness 的四种生命周期钩子接口，
 * 支持在 Agent 执行的关键节点插入自定义逻辑。
 */

import { HarnessContext, HarnessExecutionResult } from "./types";

// ============================================================
// Hook 基础类型
// ============================================================

/**
 * Hook 作用范围
 */
export enum HookScope {
  /** 全局：对所有 Agent 生效 */
  GLOBAL = "global",
  /** 特定 Agent 类型：仅对指定类型的 Agent 生效 */
  AGENT_TYPE = "agent_type",
  /** 特定实例：仅对指定 Agent 实例生效 */
  INSTANCE = "instance",
}

/**
 * Hook 失败策略
 */
export enum HookFailureStrategy {
  /** 跳过：忽略错误，继续执行后续 Hook 和 Agent */
  SKIP = "skip",
  /** 中断：终止整个 Agent 执行 */
  ABORT = "abort",
}

/**
 * Hook 执行阶段
 */
export enum HookPhase {
  PRE_EXECUTE = "preExecute",
  PRE_TOOL_USE = "preToolUse",
  POST_TOOL_USE = "postToolUse",
  POST_EXECUTE = "postExecute",
}

/**
 * Hook 执行结果
 */
export interface HookResult<T = any> {
  /** 是否中断执行 */
  abort: boolean;
  /** 修改后的数据（如果 Hook 修改了输入/输出） */
  data?: T;
  /** 中断原因（abort 为 true 时） */
  reason?: string;
}

// ============================================================
// Hook 基础接口
// ============================================================

/**
 * Harness Hook 基础接口
 *
 * 所有 Hook 类型的公共字段
 */
export interface HarnessHook {
  /** Hook 名称（用于日志和调试） */
  name: string;
  /** Hook 执行阶段 */
  phase: HookPhase;
  /** 作用范围 */
  scope: HookScope;
  /** 执行优先级（数字越小优先级越高，默认 100） */
  priority: number;
  /** 失败策略 */
  onFailure: HookFailureStrategy;
  /** 目标 Agent ID 或类型（scope 为 AGENT_TYPE 或 INSTANCE 时使用） */
  target?: string;
}

// ============================================================
// 四种 Hook 类型接口
// ============================================================

/**
 * 工具调用信息
 */
export interface ToolCallInfo {
  /** 工具调用 ID */
  toolCallId: string;
  /** 工具名称 */
  toolName: string;
  /** 工具调用参数 */
  arguments: Record<string, any>;
}

/**
 * 工具调用结果信息
 */
export interface ToolResultInfo {
  /** 工具调用 ID */
  toolCallId: string;
  /** 工具名称 */
  toolName: string;
  /** 工具返回结果 */
  result: any;
  /** 是否执行成功 */
  success: boolean;
  /** 错误信息 */
  errorMessage?: string;
}

/**
 * PreExecute Hook 接口
 *
 * 在 Agent 开始执行前触发，可用于：
 * - 注入额外上下文
 * - 修改输入
 * - 阻止执行（如权限校验失败）
 */
export interface PreExecuteHook extends HarnessHook {
  phase: HookPhase.PRE_EXECUTE;
  /** 执行函数 */
  execute(context: HarnessContext): Promise<HookResult<HarnessContext>>;
}

/**
 * PreToolUse Hook 接口
 *
 * 在 Agent 即将调用工具前触发，可用于：
 * - 校验工具参数
 * - 修改工具输入
 * - 拒绝工具调用
 */
export interface PreToolUseHook extends HarnessHook {
  phase: HookPhase.PRE_TOOL_USE;
  /** 执行函数 */
  execute(toolCall: ToolCallInfo): Promise<HookResult<ToolCallInfo>>;
}

/**
 * PostToolUse Hook 接口
 *
 * 在 Agent 工具调用完成后触发，可用于：
 * - 对工具输出进行后处理
 * - 记录日志
 * - 触发后续操作
 */
export interface PostToolUseHook extends HarnessHook {
  phase: HookPhase.POST_TOOL_USE;
  /** 执行函数 */
  execute(toolResult: ToolResultInfo): Promise<HookResult<ToolResultInfo>>;
}

/**
 * PostExecute Hook 接口
 *
 * 在 Agent 执行完成后触发，可用于：
 * - 对最终结果进行校验
 * - 格式化输出
 * - 触发清理逻辑
 */
export interface PostExecuteHook extends HarnessHook {
  phase: HookPhase.POST_EXECUTE;
  /** 执行函数 */
  execute(result: HarnessExecutionResult): Promise<HookResult<HarnessExecutionResult>>;
}

/**
 * 所有 Hook 类型的联合类型
 */
export type AnyHarnessHook =
  | PreExecuteHook
  | PreToolUseHook
  | PostToolUseHook
  | PostExecuteHook;
