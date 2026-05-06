/**
 * deerflow-harness — 统一入口
 *
 * 独立可发布的 Agent 运行时包，包含：
 * - agents: Agent 编排核心
 * - models: Model Factory
 * - tools: 工具注册与管理
 * - middleware: 中间件链
 * - config: 统一配置
 * - sandbox: 代码执行沙箱（预留）
 * - mcp: MCP 协议适配器（预留）
 * - skills: 可复用高级能力（预留）
 * - memory: 对话记忆管理（预留）
 */

// === Agents 模块 ===
export {
  AgentHarness,
  SubAgentRegistry,
  SubAgentDispatcher,
  LeadAgentHarness,
  HarnessLifecycle,
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_RECURSION_LIMIT,
  MAX_NESTING_DEPTH,
  MAX_CONCURRENT_SUB_AGENTS,
  MAX_HOOKS_CHAIN_DEPTH,
} from "./agents";
export type {
  HarnessConfig,
  HarnessContext,
  HarnessExecutionResult,
  HarnessExecutionMetrics,
  SubAgentConfig,
  ISubAgentRegistry,
} from "./agents";

// === Runtime 模块（事件流转换核心实现） ===
export {
  EventStreamAdapter,
  StreamProcessor,
  AgentEventEmitter,
} from "./runtime";
export type {
  EventStreamAdapterConfig,
  StreamProcessorConfig,
  EventFilterConfig,
} from "./runtime";

// === Models 模块 ===
export {
  createChatModel,
  loadAndValidateConfig,
  ModelResolveError,
  ModelNotFoundError,
  ConfigurationError,
} from "./models";
export type { ModelConfig, CreateModelOptions } from "./models";

// === Tools 模块 ===
export { searchWebTool } from "./tools";

// === Middleware 模块 ===
export {
  HooksManager,
  HumanReviewHook,
  createHumanReviewHook,
  HookScope,
  HookFailureStrategy,
  HookPhase,
} from "./middleware";
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
} from "./middleware";

// === Config 模块 ===
export {
  modelConfigs,
  loadAllSubAgents,
  simpleAnalyserConfig,
  taskDecomposerConfig,
  taskHandlerConfig,
  reportGeneratorConfig,
} from "./config";

// === 预留模块（类型导出） ===
export type { SandboxProvider, SandboxResult } from "./sandbox";
export type { MCPAdapter, MCPTool } from "./mcp";
export type { Skill, SkillResult } from "./skills";
export type { MemoryProvider, MemoryEntry } from "./memory";
