/**
 * Harness 模块统一导出
 *
 * Agent Harness 运行时容器的所有公共 API
 */

// 核心类型
export {
  HarnessLifecycle,
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_RECURSION_LIMIT,
  MAX_NESTING_DEPTH,
  MAX_CONCURRENT_SUB_AGENTS,
  MAX_HOOKS_CHAIN_DEPTH,
} from "./types";
export type {
  HarnessConfig,
  HarnessContext,
  HarnessExecutionResult,
  HarnessExecutionMetrics,
} from "./types";

// Hooks 类型
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

// Sub-agent 类型
export type {
  SubAgentConfig,
  ISubAgentRegistry,
} from "./subagent";

// 核心实现类
export { AgentHarness } from "./AgentHarness";
export { HooksManager } from "./HooksManager";
export { SubAgentRegistry } from "./SubAgentRegistry";
export { SubAgentDispatcher } from "./SubAgentDispatcher";
export { LeadAgentHarness } from "./LeadAgentHarness";

// Hooks 实现
export { HumanReviewHook, createHumanReviewHook } from "./hooks";

// Sub-agent 配置加载
export { loadAllSubAgents } from "./subagents";
export {
  simpleAnalyserConfig,
  taskDecomposerConfig,
  taskHandlerConfig,
  reportGeneratorConfig,
} from "./subagents";
