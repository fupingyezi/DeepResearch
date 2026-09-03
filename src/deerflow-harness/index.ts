export { DeerFlowClient } from './client';
export { createChatModel } from './models';
export { createBaseAgent } from './agents/factory';
export { searchWebTool, taskTool, getAvailableTools } from './tools';
export {
  SubagentExecutor,
  registerSubagent,
  getSubagentConfig,
  getAvailableSubagentNames,
  generalPurposeConfig,
  type SubagentConfig,
} from './subagents';
export type { ModelConfig, ClientOptions, BaseTool, SubagentEvent, ModelProvider } from './types';

export { SYSTEM_PROMPT, buildLeadAgentSystemPrompt } from './agents/lead-agent';
export type { BuildLeadAgentPromptOptions } from './agents/lead-agent';

// Sandbox 子系统（LocalSandbox + Provider 单例 + 文件工具集）
export {
  Sandbox,
  SandboxProvider,
  LocalSandbox,
  LocalSandboxProvider,
  getSandboxProvider,
  resetSandboxProvider,
  setSandboxProvider,
  SandboxError,
  SandboxNotFoundError,
  SandboxRuntimeError,
  SandboxPermissionError,
  SandboxFileNotFoundError,
  isHostBashAllowed,
  LOCAL_HOST_BASH_DISABLED_MESSAGE,
  getSandboxBaseDir,
  getThreadDirectories,
  getSandboxSnapshot,
  VIRTUAL_PATH_PREFIX,
  SANDBOX_TOOLS,
  type GrepMatch,
  type ThreadDirectories,
  type SandboxSnapshot,
  type SandboxContainerSnapshot,
} from './sandbox';

// extensions 子系统（MCP / skill 统一配置）
export {
  type McpTransport,
  type McpServerConfig,
  type SkillState,
  type ExtensionsConfig,
  mcpServerConfigSchema,
  skillStateSchema,
  extensionsConfigSchema,
  createEmptyExtensionsConfig,
  resolveEnvPlaceholders,
  getExtensionsConfigPath,
  getSkillsRootDir,
  getPublicSkillsDir,
  getCustomSkillsDir,
  type ExtensionsConfigStore,
  FileExtensionsConfigStore,
  getExtensionsConfigStore,
  resetExtensionsConfigStore,
} from './extensions';

// skill 子系统（Prompt 注入式）
export {
  type Skill,
  type SkillCategory,
  type CreateCustomSkillInput,
  SKILL_NAME_PATTERN,
  validateSkillName,
  parseFrontmatter,
  loadSkills,
  loadEnabledSkills,
  getEnabledSkillsSignature,
  resetSkillCache,
  createCustomSkill,
  buildSkillsSection,
} from './skills';

// MCP 子系统（端到端：配置→连接→工具注入）
export { type McpToolsResult, loadMcpTools, getEnabledMcpSignature, resetMcpClient } from './mcp';

// Memory 子系统
export {
  // types
  type Fact,
  type FactCategory,
  type HistorySection,
  type MemoryData,
  type SectionData,
  type UserSection,
  createEmptyMemory,
  utcNowIsoZ,
  validateAgentName,
  AGENT_NAME_PATTERN,
  // config
  type MemoryConfig,
  DEFAULT_MEMORY_CONFIG,
  getMemoryConfig,
  loadMemoryConfigFromDict,
  setMemoryConfig,
  // paths
  agentMemoryFile,
  getBaseDir,
  memoryFile,
  userAgentMemoryFile,
  userMemoryFile,
  // storage
  type MemoryStorage,
  FileMemoryStorage,
  getMemoryStorage,
  resetMemoryStorage,
  // prompt utilities
  countTokens,
  formatConversationForUpdate,
  formatMemoryForInjection,
  MEMORY_UPDATE_PROMPT,
  setTokenCounter,
  type TokenCounter,
  // message processing
  detectCorrection,
  detectReinforcement,
  filterMessagesForMemory,
  hasUserAndAi,
  // updater & manual fact CRUD
  clearMemoryData,
  createMemoryFact,
  deleteMemoryFact,
  getMemoryData,
  getMemoryModelFactory,
  importMemoryData,
  MemoryUpdater,
  reloadMemoryData,
  setMemoryModelFactory,
  updateMemoryFact,
  updateMemoryFromConversation,
  type MemoryModelFactory,
  type UpdateMemoryOptions,
  // queue
  getMemoryQueue,
  MemoryUpdateQueue,
  resetMemoryQueue,
  type AddArgs as MemoryQueueAddArgs,
  type ConversationContext as MemoryConversationContext,
  // facade
  buildMemoryContext,
  type BuildMemoryContextOptions,
} from './agents/memory';

export {
  setTitleModelFactory,
  getTitleModelFactory,
  type TitleModelFactory,
  consumeTitleUpdate,
  type TitleUpdatePayload,
} from './agents/middlewares';

export {
  createSseStream,
  toClientAgentEvent,
  createClientAgentEvent,
  ClientAgentEventType,
  type ClientAgentEvent,
  type ClientAgentEventStream,
} from './runtime/sse';

// Thread 系统（runtime + persistence）

// runtime/checkpointer
export {
  buildThreadConfig,
  makeCheckpointer,
  type CheckpointerKind,
  type CheckpointerHandle,
  type ThreadConfig,
} from './runtime/checkpointer';

// runtime/context
export { runWithContext, getContext, requireContext, type RuntimeContext } from './runtime/context';

// runtime/stream-bridge
export { streamBridge, StreamBridge, ThreadChannel } from './runtime/stream-bridge';

// runtime/service
export {
  createThreadService,
  type ThreadService,
  type ThreadServiceDeps,
  type CreateThreadInput,
  type ListThreadsOptions,
  type GetThreadInput,
  type DeleteThreadInput,
  type SubmitRunInput,
  type SubscribeInput,
  type GetCheckpointInput,
} from './runtime/service';

// persistence/thread-meta
export {
  PgThreadMetaStore,
  type ThreadMeta,
  type ThreadMetaStore,
  type ThreadStatus,
  type ThreadMetaCreateInput,
  type ThreadMetaSearchOptions,
} from './persistence/thread-meta';

// persistence/runs
export {
  PgRunStore,
  type Run,
  type RunStore,
  type RunStatus,
  type RunCreateInput,
  type RunListOptions,
} from './persistence/runs';
