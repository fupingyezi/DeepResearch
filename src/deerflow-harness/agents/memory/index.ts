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
  factScoreParts,
  overlapRatio,
  previewFactScores,
  retrievalThresholds,
  retrieveMemory,
  scoreFact,
  tokenize,
  type FactScoreDetail,
  type FactScoreParts,
  type RetrievalOptions,
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

import { getMemoryConfig as _gmc } from './config';
import { backfillFactEmbeddings as _backfill, embedQuery as _embedQuery } from './embeddings';
import { getMemoryStorage as _gms } from './storage';
import { formatMemoryForInjection as _fmt } from './prompt';
import {
  previewFactScores,
  retrieveMemory,
  retrievalThresholds,
  type FactScoreDetail,
} from './retrieval';
import type { MemoryData } from './types';

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

interface RetrieveForInjectionOutcome {
  queryEmbedding: number[] | null;
  /** 检索命中的子集；未命中（query 空 / 全部落空）为 null。 */
  picked: MemoryData | null;
  /** 真正会拼进 system prompt 的整段文本；空串 = 不注入。 */
  injectedText: string;
}

/**
 * 检索模式的共用实现：`buildMemoryContext` 与 `previewMemoryRetrieval` 都走这里，
 * 保证「预览看到的」与「实际注入的」是同一段代码的产物、不会漂移。
 */
async function retrieveForInjection(
  data: MemoryData,
  opts: { agentName: string | null; userId: string | null; query: string },
): Promise<RetrieveForInjectionOutcome> {
  const config = _gmc();
  // 语义检索：query 一次性向量化（无 Key / 失败 → null，回落纯词面）；
  // 顺手 fire-and-forget 回填缺失向量的旧数据（内部 in-flight 去重，不阻塞本次检索）。
  let queryEmbedding: number[] | null = null;
  if (config.embeddingEnabled) {
    queryEmbedding = await _embedQuery(opts.query);
    if (queryEmbedding && config.embeddingBackfillOnLoad) {
      void _backfill({ agentName: opts.agentName, userId: opts.userId });
    }
  }

  const picked = retrieveMemory(data, opts.query, {
    topK: config.retrieveTopK,
    queryEmbedding,
    hybridWeight: config.embeddingHybridWeight,
  });
  const pickedText = picked ? _fmt(picked, config.retrieveMaxTokens) : '';
  return {
    queryEmbedding,
    picked,
    injectedText: pickedText.trim() ? `<memory mode="retrieve">\n${pickedText}\n</memory>\n` : '',
  };
}

/** 检索预览结果（供调试接口展示，不参与生产链路）。 */
export interface MemoryRetrievalPreview {
  query: string;
  /** 当前生效的记忆/检索配置。 */
  config: {
    embeddingEnabled: boolean;
    embeddingDimensions: number;
    embeddingHybridWeight: number;
    embeddingBackfillOnLoad: boolean;
    retrieveTopK: number;
    retrieveMaxTokens: number;
  };
  /** 不可配置的两个门槛常量。 */
  thresholds: { semanticMatch: number; minScore: number };
  /** query 是否成功向量化（false = 无 Key / API 失败，本次为纯词面检索）。 */
  embedded: boolean;
  queryEmbeddingDim: number | null;
  /** 逐条 fact 的打分明细（按得分降序，含未入选者）。 */
  facts: FactScoreDetail[];
  /** 实际会拼进 prompt 的文本；空串 = 本轮不注入。 */
  injectedText: string;
}

/**
 * 预览检索效果：走与真实注入完全相同的代码路径，返回逐条打分明细 + 最终注入文本。
 *
 * 用途：`memoryMode: 'retrieve'` 目前无前端开关，本入口让「哪些 fact 被选中、
 * 词面/余弦各占多少、为什么没选中」可直接观察（见 /api/memory/retrieve）。
 */
export async function previewMemoryRetrieval(opts: {
  agentName?: string | null;
  userId?: string | null;
  query: string;
}): Promise<MemoryRetrievalPreview> {
  const config = _gmc();
  const agentName = opts.agentName ?? null;
  const userId = opts.userId ?? null;
  const data = await _gms().load({ agentName, userId });

  const outcome = await retrieveForInjection(data, {
    agentName,
    userId,
    query: opts.query,
  });

  return {
    query: opts.query,
    config: {
      embeddingEnabled: config.embeddingEnabled,
      embeddingDimensions: config.embeddingDimensions,
      embeddingHybridWeight: config.embeddingHybridWeight,
      embeddingBackfillOnLoad: config.embeddingBackfillOnLoad,
      retrieveTopK: config.retrieveTopK,
      retrieveMaxTokens: config.retrieveMaxTokens,
    },
    thresholds: retrievalThresholds(),
    embedded: outcome.queryEmbedding != null,
    queryEmbeddingDim: outcome.queryEmbedding?.length ?? null,
    facts: previewFactScores(data, opts.query, {
      topK: config.retrieveTopK,
      queryEmbedding: outcome.queryEmbedding,
      hybridWeight: config.embeddingHybridWeight,
    }),
    injectedText: outcome.injectedText,
  };
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
      const outcome = await retrieveForInjection(data, {
        agentName: opts.agentName ?? null,
        userId: opts.userId ?? null,
        query: opts.query ?? '',
      });
      return outcome.injectedText;
    }

    const text = _fmt(data, config.maxInjectionTokens);
    if (!text.trim()) return '';
    return `<memory>\n${text}\n</memory>\n`;
  } catch (e) {
    console.error('[memory] Failed to build memory context:', e);
    return '';
  }
}
