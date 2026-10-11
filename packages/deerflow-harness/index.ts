export { DeerFlowClient, buildConfigKey, resolveRuntimeOptions } from './client';
export type { RuntimeRunOptions } from './client';
export { createChatModel } from './models';
export { createBaseAgent } from './agents/factory';
export {
  registerExtraMiddleware,
  getExtraMiddlewares,
  getExtraMiddlewaresSignature,
  resetExtraMiddlewares,
  type MiddlewareScope,
  type RegisterExtraMiddlewareOptions,
} from './agents/extra-middlewares';
export { Next, Prev, type MiddlewareAnchor } from './agents/features';
export { searchWebTool, taskTool, viewImageTool, skillTool, getAvailableTools } from './tools';
export {
  SubagentExecutor,
  registerSubagent,
  getSubagentConfig,
  getAvailableSubagentNames,
  generalPurposeConfig,
  setParentHistoryProvider,
  type SubagentConfig,
  type ParentHistoryProvider,
} from './subagents';
export type {
  ModelConfig,
  ClientOptions,
  BaseTool,
  SubagentEvent,
  ModelProvider,
  MiddlewareOptions,
} from './types';

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
} from './extensions/skills';

// MCP 子系统（端到端：配置→连接→工具注入）
export {
  type McpToolsResult,
  loadMcpTools,
  getEnabledMcpSignature,
  resetMcpClient,
} from './extensions/mcp';

// 中间件装配 YAML 配置（对齐 deer-flow 2.0 config.yaml 约定）
export {
  middlewareConfigYamlSchema,
  parseMiddlewareConfigYaml,
  resolveConfigEnvPlaceholders,
  createDefaultMiddlewareConfigYaml,
  MIDDLEWARE_CONFIG_VERSION,
  type MiddlewareConfigYaml,
  type MiddlewareConfigSnapshot,
  type MiddlewareConfigProvider,
} from './config';

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
  // storage
  type MemoryStorage,
  type MemorySqlExecutor,
  type VectorSearchResult,
  InMemoryMemoryStorage,
  getMemoryStorage,
  resetMemoryStorage,
  setMemoryStorage,
  // prompt utilities
  countTokens,
  estimateTokensHeuristic,
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
  // embeddings（语义检索）
  backfillMemoryEmbeddings,
  cosineSimilarity,
  EMBEDDING_BATCH_LIMIT,
  embedQuery,
  embedTexts,
  getMemoryEmbeddingsFactory,
  isCompatibleVector,
  resetMemoryEmbeddingsFactory,
  setMemoryEmbeddingsFactory,
  type MemoryEmbeddingsFactory,
  // rerank（RAG 精排）
  getMemoryRerankerFactory,
  rerankWithFallback,
  resetMemoryRerankerFactory,
  setMemoryRerankerFactory,
  type MemoryReranker,
  type MemoryRerankerFactory,
  // facade
  buildMemoryContext,
  previewMemoryRetrieval,
  type BuildMemoryContextOptions,
  type MemoryRetrievalPreview,
  // retrieval（RAG 管线：BM25/向量双路召回 → RRF → rerank；明细供预览/调试）
  bm25Score,
  buildBm25Stats,
  lexicalRecall,
  retrieveMemory,
  rrfFuse,
  tokenize,
  vectorRecallJs,
  type Bm25Stats,
  type FactScoreDetail,
  type RetrieveResult,
  type SectionScoreDetail,
} from './agents/memory';

// vision（多模态：图片字节注入 + 多模态消息构造 + 历史图压缩）
export {
  buildHumanMessageContent,
  contentHasImageBlocks,
  extractContentTextBlocks,
  getThreadImageFetcher,
  maxImageBytesFromEnv,
  setThreadImageFetcher,
  visionMiddleware,
  type BuildContentOptions,
  type BuildContentResult,
  type FetchedImage,
  type ThreadImageFetcher,
  type ThreadImageRef,
} from './vision';

export {
  setTitleModelFactory,
  getTitleModelFactory,
  getPromptEnhanceModel,
  type TitleModelFactory,
  type TitleModelOptions,
  consumeTitleUpdate,
  type TitleUpdatePayload,
  type GuardrailOptions,
  type GuardrailBlockMode,
  type SubagentLimitOptions,
  type LoopDetectionOptions,
  type SummarizationOptions,
} from './agents/middlewares';

export {
  createSseStream,
  toClientAgentEvent,
  createClientAgentEvent,
  ClientAgentEventType,
  type ClientAgentEvent,
  type ClientAgentEventStream,
  type SseStreamEvent,
  type StampedClientAgentEvent,
} from './runtime/sse';

// runtime（宿主装配面：checkpoint / ALS 上下文 / Redis 客户端注入）

// runtime/checkpointer
export {
  buildThreadConfig,
  makeCheckpointer,
  type CheckpointerKind,
  type CheckpointerHandle,
  type PostgresCheckpointerOptions,
  type MakeCheckpointerOptions,
  type ThreadConfig,
} from './runtime/checkpointer';

// runtime/context
export { runWithContext, getContext, type RuntimeContext } from './runtime/context';

// runtime/redis-client-factory（宿主注入 Redis 客户端；沙箱协调与 app 侧跨进程实现共用）
export {
  setRedisClientFactory,
  getRedisClientFactory,
  type RedisClientFactory,
  type RedisClientOptions,
  type RedisClient,
} from './runtime/redis-client-factory';

// types/sql-executor —— 宿主注入的最小 SQL 执行面（单查询 + 事务）
export type { SqlExecutor } from './types';

// 宿主注入面：标题存储 / 上传文件 / Tavily Key（实现归宿主，harness 只消费接口）
export {
  setTitleStoreProvider,
  getTitleStoreProvider,
  type TitleStoreProvider,
} from './agents/middlewares/title-store';
export {
  setUploadedFilesProvider,
  getUploadedFilesProvider,
  type UploadedFilesProvider,
} from './agents/middlewares/uploaded-files';
export { setTavilyApiKey } from './tools/builtins/search-web-tool';
