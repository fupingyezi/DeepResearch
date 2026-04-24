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

// Harness 核心类
export {
  AgentHarness,
  HooksManager,
  SubAgentRegistry,
  SubAgentDispatcher,
  LeadAgentHarness,
} from "./harness";

// Harness 类型
export {
  HarnessLifecycle,
  HookScope,
  HookFailureStrategy,
  HookPhase,
} from "./harness";
export type {
  HarnessConfig,
  HarnessContext,
  HarnessExecutionResult,
  HarnessExecutionMetrics,
  SubAgentConfig,
  ISubAgentRegistry,
  HarnessHook,
  PreExecuteHook,
  PreToolUseHook,
  PostToolUseHook,
  PostExecuteHook,
} from "./harness";

// Harness Hooks 实现
export { HumanReviewHook, createHumanReviewHook } from "./harness";

// Sub-agent 配置加载
export { loadAllSubAgents } from "./harness";
