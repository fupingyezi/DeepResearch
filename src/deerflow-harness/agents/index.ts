/**
 * Agents Module — deerflow-harness
 *
 * Agent 编排核心的所有公共 API
 *
 * @module deerflow-harness/agents
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

// Sub-agent 类型
export type {
  SubAgentConfig,
  ISubAgentRegistry,
} from "./subagent";

// 核心实现类
export { AgentHarness } from "./AgentHarness";
export { SubAgentRegistry } from "./SubAgentRegistry";
export { SubAgentDispatcher } from "./SubAgentDispatcher";
export { LeadAgentHarness } from "./LeadAgentHarness";
