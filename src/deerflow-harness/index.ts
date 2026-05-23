export { DeerFlowClient } from './clinet';
export { createChatModel } from './models';
export { createBaseAgent } from './agents/factory';
export { searchWebTool, taskTool, getAvailableTools } from './tools';
export {
  SubagentExecutor,
  registerSubagent,
  getSubagentConfig,
  getAvailableSubagentNames,
  researchConfig,
  type SubagentConfig,
} from './subagents';
export type { ModelConfig, ClientOptions, BaseTool, SubagentEvent } from './types';

export { SYSTEM_PROMPT, buildLeadAgentSystemPrompt } from './agents/lead-agent';
export type { BuildLeadAgentPromptOptions } from './agents/lead-agent';

/* -------------------------------------------------------------------------- */
/*  Memory subsystem                                                           */
/* -------------------------------------------------------------------------- */

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
} from './memory';

export {
  createSseStream,
  toClientAgentEvent,
  createClientAgentEvent,
  ClientAgentEventType,
  type ClientAgentEvent,
  type ClientAgentEventStream,
} from './runtime/sse';

/* -------------------------------------------------------------------------- */
/*  Thread 系统（runtime + persistence）                                       */
/* -------------------------------------------------------------------------- */

// runtime/checkpointer
export {
  buildThreadConfig,
  makeCheckpointer,
  type CheckpointerKind,
  type CheckpointerHandle,
  type ThreadConfig,
} from './runtime/checkpointer';

// runtime/context
export {
  runWithContext,
  getContext,
  requireContext,
  type RuntimeContext,
} from './runtime/context';

// runtime/stream-bridge
export {
  streamBridge,
  StreamBridge,
  ThreadChannel,
} from './runtime/stream-bridge';

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
