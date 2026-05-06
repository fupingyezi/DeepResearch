// Agent 基类和配置
export { BaseAgentServer } from "./BaseAgentServer";
export type {
  AgentConfig,
  AgentCapabilityConfig,
  AgentResponse,
  AgentHandler,
} from "./BaseAgentServer";

// Agent 实现
export { ChatAgentServer } from "./ChatAgentServer";
export { SearchAgentServer } from "./SearchAgentServer";
export { DeepResearchAgentServer } from "./DeepResearchAgentServer";

// Agent 管理器和事件总线
export { AgentManager, AgentType, EventBus } from "./AgentManager";

// 组合模块
export { AgentEventEmitter, StreamProcessor } from "./modules";
export type { StreamProcessorConfig } from "./modules";

// 事件流适配器
export { EventStreamAdapter } from "./eventStream";
export type {
  EventStreamAdapterConfig,
  EventFilterConfig,
} from "./eventStream";

// 提示词
export { CHAT_SYSTEM_PROMPT } from "./prompts";

// Harness 核心类（从 deerflow-harness 包 re-export）
export {
  AgentHarness,
  SubAgentRegistry,
  SubAgentDispatcher,
  LeadAgentHarness,
  HarnessLifecycle,
} from "@deerflow-harness/agents";
export type {
  HarnessConfig,
  HarnessContext,
  HarnessExecutionResult,
  HarnessExecutionMetrics,
  SubAgentConfig,
  ISubAgentRegistry,
} from "@deerflow-harness/agents";

// Harness Middleware（Hooks）
export {
  HooksManager,
  HookScope,
  HookFailureStrategy,
  HookPhase,
  HumanReviewHook,
  createHumanReviewHook,
} from "@deerflow-harness/middleware";
export type {
  HarnessHook,
  PreExecuteHook,
  PreToolUseHook,
  PostToolUseHook,
  PostExecuteHook,
} from "@deerflow-harness/middleware";

// Sub-agent 配置加载
export { loadAllSubAgents } from "@deerflow-harness/config";
