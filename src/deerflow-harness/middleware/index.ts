/**
 * Middleware Module — deerflow-harness
 *
 * Agent 中间件链（由 Hooks 系统演化而来）
 *
 * @module deerflow-harness/middleware
 */

// Hooks 类型定义
export {
  HookScope,
  HookFailureStrategy,
  HookPhase,
} from "./hooks";
export type {
  HarnessHook,
  HookResult,
  ToolCallInfo,
  ToolResultInfo,
  PreExecuteHook,
  PreToolUseHook,
  PostToolUseHook,
  PostExecuteHook,
  AnyHarnessHook,
} from "./hooks";

// Hooks 管理器
export { HooksManager } from "./HooksManager";

// Hooks 实现
export { HumanReviewHook, createHumanReviewHook } from "./HumanReviewHook";
