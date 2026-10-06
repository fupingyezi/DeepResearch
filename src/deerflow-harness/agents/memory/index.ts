/**
 * Memory subsystem 公共门面
 *
 * 上层（lead-agent prompt builder / memoryMiddleware / HTTP API）应仅依赖本文件。
 */

export type {
  Fact,
  FactCategory,
  HistorySection,
  MemoryData,
  SectionData,
  UserSection,
} from './types';
export { createEmptyMemory, utcNowIsoZ, validateAgentName, AGENT_NAME_PATTERN } from './types';

export type { MemoryConfig } from './config';
export {
  DEFAULT_MEMORY_CONFIG,
  getMemoryConfig,
  loadMemoryConfigFromDict,
  setMemoryConfig,
} from './config';

export type { MemorySqlExecutor, MemoryStorage, VectorSearchResult } from './storage';
export { getMemoryStorage, resetMemoryStorage, setMemoryStorage } from './storage';
export { PgMemoryStorage } from './pg-storage';

export type { MemoryReranker, MemoryRerankerFactory } from './rerank';
export {
  getMemoryRerankerFactory,
  rerankWithFallback,
  resetMemoryRerankerFactory,
  setMemoryRerankerFactory,
} from './rerank';

export {
  backfillMemoryEmbeddings,
  cosineSimilarity,
  EMBEDDING_BATCH_LIMIT,
  embedQuery,
  embedTexts,
  getMemoryEmbeddingsFactory,
  isCompatibleVector,
  isUnitVector,
  normalizeVector,
  resetMemoryEmbeddingsFactory,
  RECALL_SECTION_SLOTS,
  setMemoryEmbeddingsFactory,
  type MemoryEmbeddingsFactory,
} from './embeddings';

export {
  countTokens,
  estimateTokensHeuristic,
  formatConversationForUpdate,
  formatMemoryForInjection,
  MEMORY_UPDATE_PROMPT,
  setTokenCounter,
  type TokenCounter,
} from './prompt';

export {
  bm25Score,
  buildBm25Stats,
  lexicalRecall,
  retrieveMemory,
  rrfFuse,
  tokenize,
  vectorRecallJs,
  type Bm25Stats,
  type FactScoreDetail,
  type LexicalHit,
  type RetrieveOptions,
  type RetrieveResult,
  type RrfEntry,
  type SectionScoreDetail,
} from './retrieval';

export {
  detectCorrection,
  detectReinforcement,
  filterMessagesForMemory,
  hasUserAndAi,
} from './message-processing';

export {
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
} from './updater';

export {
  getMemoryQueue,
  MemoryUpdateQueue,
  resetMemoryQueue,
  type AddArgs,
  type ConversationContext,
} from './queue';

export {
  buildMemoryContext,
  previewMemoryRetrieval,
  type BuildMemoryContextOptions,
  type MemoryRetrievalPreview,
} from './injection';
