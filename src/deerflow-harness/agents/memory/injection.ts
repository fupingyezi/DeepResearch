/**
 * 记忆注入：`buildMemoryContext` 与预览接口的共用实现。
 *
 * 两个入口都走 `retrieveForInjection`——预览看到的（打分明细 / 注入文本）与
 * 实际拼进 system prompt 的是同一段代码的产物，不会漂移。
 */

import { getMemoryConfig } from './config';
import { backfillMemoryEmbeddings, embedQuery } from './embeddings';
import { formatMemoryForInjection } from './prompt';
import { rerankWithFallback } from './rerank';
import {
  retrieveMemory,
  type FactScoreDetail,
  type RetrieveResult,
  type SectionScoreDetail,
} from './retrieval';
import { getMemoryStorage, type VectorSearchResult } from './storage';
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
  /** retrieve 模式的语义 query（当前轮用户输入；resume 无本轮文本时由历史顶替）。 */
  query?: string;
  /** 近 N 轮人类输入（旧→新）；仅参与词面 query 拼接，不参与向量化。 */
  recentQueries?: string[];
}

interface RetrieveForInjectionOutcome {
  queryEmbedding: number[] | null;
  /** 真正会拼进 system prompt 的整段文本；空串 = 不注入。 */
  injectedText: string;
  /** 管线全量产物（打分明细 / poolSize / rerankUsed / vectorLeg），供预览同源消费。 */
  result: RetrieveResult | null;
}

/**
 * 检索模式的共用实现：`buildMemoryContext` 与 `previewMemoryRetrieval` 都走这里，
 * 保证「预览看到的」与「实际注入的」是同一段代码的产物、不会漂移。
 */
async function retrieveForInjection(
  data: MemoryData,
  opts: {
    agentName: string | null;
    userId: string | null;
    query: string;
    recentQueries?: string[];
  },
): Promise<RetrieveForInjectionOutcome> {
  const config = getMemoryConfig();
  // 词面 query = 近 N 轮拼接（去重：resume 时语义 query 即最近一轮，不重复计入）；
  // 语义 query 只取当前轮——拼串会稀释句向量语义，语义门槛标定基于单句。
  const lexicalQuery = [...(opts.recentQueries ?? []), opts.query]
    .map((s) => (s ?? '').trim())
    .filter((s, i, arr) => Boolean(s) && arr.indexOf(s) === i)
    .join('\n');

  // 语义检索：query 一次性向量化（无 Key / 失败 → null，回落纯词面）；
  // 顺手 fire-and-forget 回填缺失向量的旧数据（内部 in-flight 去重，不阻塞本次检索）。
  let queryEmbedding: number[] | null = null;
  if (config.embeddingEnabled) {
    queryEmbedding = await embedQuery(opts.query);
    if (queryEmbedding && config.embeddingBackfillEnabled) {
      void backfillMemoryEmbeddings({ agentName: opts.agentName, userId: opts.userId });
    }
  }

  // 管线 deps：vectorRecall 来自 storage 后端（PG 走 pgvector；无后端时
  // 管线内部回落 JS 扫描）；rerank 走 rerankWithFallback（工厂缺失 / API 失败
  // 返回 null，管线保持 RRF 序）。rerankQuery 用本轮单句——拼串会稀释语义。
  const storage = getMemoryStorage();
  const vectorSearch = storage.vectorSearch;
  const vectorRecall: ((q: number[], n: number) => Promise<VectorSearchResult[]>) | null =
    vectorSearch
      ? (queryVector, limit) =>
          vectorSearch({ agentName: opts.agentName, userId: opts.userId }, queryVector, limit)
      : null;
  const result = await retrieveMemory(data, lexicalQuery, {
    topK: config.retrieveTopK,
    queryEmbedding,
    semanticMatchThreshold: config.semanticMatchThreshold,
    vectorRecall,
    rerank: config.rerankEnabled ? rerankWithFallback : null,
    rerankQuery: opts.query.trim() ? opts.query : undefined,
  });

  const pickedText = result
    ? formatMemoryForInjection(result.picked, config.retrieveMaxTokens, {
        preserveFactOrder: true,
      })
    : '';
  return {
    queryEmbedding,
    injectedText: pickedText.trim() ? `<memory mode="retrieve">\n${pickedText}\n</memory>\n` : '',
    result,
  };
}

/** 检索预览结果（供调试接口展示，不参与生产链路）。 */
export interface MemoryRetrievalPreview {
  query: string;
  /** 当前生效的记忆/检索配置。 */
  config: {
    embeddingEnabled: boolean;
    embeddingDimensions: number;
    embeddingBackfillEnabled: boolean;
    retrieveTopK: number;
    retrieveMaxTokens: number;
    semanticMatchThreshold: number;
    rerankEnabled: boolean;
  };
  /** 路 A 召回门槛的生效值（取自 MemoryConfig，便于解读打分明细）。 */
  thresholds: { semanticMatch: number };
  /** query 是否成功向量化（false = 无 Key / API 失败，本次为纯词面检索）。 */
  embedded: boolean;
  queryEmbeddingDim: number | null;
  /** 向量路来源：pg / js（兜底扫描）/ null（无向量）。 */
  vectorLeg: 'pg' | 'js' | null;
  /** 本轮是否真的走了 rerank 精排。 */
  rerankUsed: boolean;
  /** RRF 融合后的候选池大小。 */
  poolSize: number;
  /** 逐条 fact 的打分明细（按 final 降序，含未入选者）。 */
  facts: FactScoreDetail[];
  /** 4 个召回 section 的打分明细。 */
  sections: SectionScoreDetail[];
  /** 实际会拼进 prompt 的文本；空串 = 本轮不注入。 */
  injectedText: string;
}

/**
 * 预览检索效果：走与真实注入完全相同的代码路径，明细直接取自 retrieveForInjection
 * 的管线产物（构造性同源，不存在二次重算、不会漂移）。见 /api/memory/retrieve。
 */
export async function previewMemoryRetrieval(opts: {
  agentName?: string | null;
  userId?: string | null;
  query: string;
}): Promise<MemoryRetrievalPreview> {
  const config = getMemoryConfig();
  const agentName = opts.agentName ?? null;
  const userId = opts.userId ?? null;
  const data = await getMemoryStorage().load({ agentName, userId });

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
      embeddingBackfillEnabled: config.embeddingBackfillEnabled,
      retrieveTopK: config.retrieveTopK,
      retrieveMaxTokens: config.retrieveMaxTokens,
      semanticMatchThreshold: config.semanticMatchThreshold,
      rerankEnabled: config.rerankEnabled,
    },
    thresholds: { semanticMatch: config.semanticMatchThreshold },
    embedded: outcome.queryEmbedding != null,
    queryEmbeddingDim: outcome.queryEmbedding?.length ?? null,
    vectorLeg: outcome.result?.vectorLeg ?? null,
    rerankUsed: outcome.result?.rerankUsed ?? false,
    poolSize: outcome.result?.poolSize ?? 0,
    facts: outcome.result?.facts ?? [],
    sections: outcome.result?.sections ?? [],
    injectedText: outcome.injectedText,
  };
}

/**
 * 加载 memory 并格式化为 `<memory>...</memory>\n` 字符串，便于直接拼到 system
 * prompt。配置关闭、内容为空或读取异常时一律返回空字符串。
 */
export async function buildMemoryContext(opts: BuildMemoryContextOptions = {}): Promise<string> {
  try {
    const config = getMemoryConfig();
    if (!config.enabled || !config.injectionEnabled) {
      console.warn('[memory] early return: config disabled');
      return '';
    }
    const data = await getMemoryStorage().load({
      agentName: opts.agentName ?? null,
      userId: opts.userId ?? null,
    });

    // retrieve 模式：先按 query 收敛出相关子集，再用更小的预算格式化。
    // query 无信号或全部落空 → 不注入，避免无关记忆干扰模型。
    if (opts.mode === 'retrieve') {
      const outcome = await retrieveForInjection(data, {
        agentName: opts.agentName ?? null,
        userId: opts.userId ?? null,
        query: opts.query ?? '',
        recentQueries: opts.recentQueries,
      });
      return outcome.injectedText;
    }

    const text = formatMemoryForInjection(data, config.maxInjectionTokens);
    if (!text.trim()) return '';
    return `<memory>\n${text}\n</memory>\n`;
  } catch (e) {
    console.error('[memory] Failed to build memory context:', e);
    return '';
  }
}
