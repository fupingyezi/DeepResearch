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

export {
  agentMemoryFile,
  getBaseDir,
  memoryFile,
  userAgentMemoryFile,
  userMemoryFile,
} from './paths';

export type { MemoryStorage } from './storage';
export { FileMemoryStorage, getMemoryStorage, resetMemoryStorage } from './storage';

export {
  backfillFactEmbeddings,
  cosineSimilarity,
  EMBEDDING_BATCH_LIMIT,
  embedQuery,
  embedTexts,
  getMemoryEmbeddingsFactory,
  isCompatibleVector,
  resetMemoryEmbeddingsFactory,
  setMemoryEmbeddingsFactory,
  type MemoryEmbeddingsFactory,
} from './embeddings';

export {
  countTokens,
  formatConversationForUpdate,
  formatMemoryForInjection,
  MEMORY_UPDATE_PROMPT,
  setTokenCounter,
  type TokenCounter,
} from './prompt';

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

import { getMemoryConfig as _gmc } from './config';
import { backfillFactEmbeddings as _backfill, embedQuery as _embedQuery } from './embeddings';
import { getMemoryStorage as _gms } from './storage';
import { formatMemoryForInjection as _fmt } from './prompt';
import { retrieveMemory } from './retrieval';

export interface BuildMemoryContextOptions {
  agentName?: string | null;
  userId?: string | null;
  /**
   * 注入模式：
   * - 'inject'（默认）：全量注入所有 section 与预算内 facts；
   * - 'retrieve'：按 query 检索相关 facts / section，用更小预算注入。
   */
  mode?: 'inject' | 'retrieve';
  /** retrieve 模式的检索 query（通常为最近一条用户输入）。 */
  query?: string;
}

/**
 * 加载 memory 并格式化为 `<memory>...</memory>\n` 字符串，便于直接拼到 system
 * prompt。配置关闭、内容为空或读取异常时一律返回空字符串。
 */
export async function buildMemoryContext(opts: BuildMemoryContextOptions = {}): Promise<string> {
  try {
    const config = _gmc();
    if (!config.enabled || !config.injectionEnabled) {
      console.warn('[memory] early return: config disabled');
      return '';
    }
    const data = await _gms().load({
      agentName: opts.agentName ?? null,
      userId: opts.userId ?? null,
    });

    // retrieve 模式：先按 query 收敛出相关子集，再用更小的预算格式化。
    // 检索无命中（或 query 为空）时不注入，避免无关记忆干扰模型。
    if (opts.mode === 'retrieve') {
      // 语义检索：query 一次性向量化（无 Key / 失败 → null，回落纯词面）；
      // 顺手 fire-and-forget 回填缺失向量的旧数据（内部 in-flight 去重，
      // 不阻塞本次检索）。
      let queryEmbedding: number[] | null = null;
      if (config.embeddingEnabled) {
        queryEmbedding = await _embedQuery(opts.query ?? '');
        if (queryEmbedding && config.embeddingBackfillOnLoad) {
          void _backfill({
            agentName: opts.agentName ?? null,
            userId: opts.userId ?? null,
          });
        }
      }
      const picked = retrieveMemory(data, opts.query ?? '', {
        topK: config.retrieveTopK,
        queryEmbedding,
        hybridWeight: config.embeddingHybridWeight,
      });
      if (!picked) return '';
      const pickedText = _fmt(picked, config.retrieveMaxTokens);
      if (!pickedText.trim()) return '';
      return `<memory mode="retrieve">\n${pickedText}\n</memory>\n`;
    }

    const text = _fmt(data, config.maxInjectionTokens);
    if (!text.trim()) return '';
    return `<memory>\n${text}\n</memory>\n`;
  } catch (e) {
    console.error('[memory] Failed to build memory context:', e);
    return '';
  }
}
