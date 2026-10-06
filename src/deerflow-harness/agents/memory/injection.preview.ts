/**
 * 记忆注入的「检索效果预览」（*.preview.ts：仅调试/观察入口使用，不进生产链路）。
 *
 * 预览走与真实注入完全相同的代码路径（retrieveForInjection → retrieveMemory），
 * 明细直接取自管线产物（构造性同源，不存在二次重算、不会漂移）。
 * 对应 HTTP 入口：GET /api/memory/retrieve（app 侧 memory-service.preview.ts）。
 */

import { getMemoryConfig } from './config';
import { retrieveForInjection } from './injection';
import {
  buildRetrievalDetail,
  type FactScoreDetail,
  type SectionScoreDetail,
} from './retrieval.preview';
import { getMemoryStorage } from './storage';

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

  const outcome = await retrieveForInjection(
    data,
    {
      agentName,
      userId,
      query: opts.query,
    },
    true,
  );
  const trace = outcome.result?.trace ?? null;
  const detail = trace ? buildRetrievalDetail(data, trace) : { facts: [], sections: [] };

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
    vectorLeg: trace?.vectorLeg ?? null,
    rerankUsed: trace?.rerankUsed ?? false,
    poolSize: trace?.poolSize ?? 0,
    facts: detail.facts,
    sections: detail.sections,
    injectedText: outcome.injectedText,
  };
}
