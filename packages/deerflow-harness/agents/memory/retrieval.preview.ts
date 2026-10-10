/**
 * 记忆检索的「打分明细」组装（*.preview.ts：仅调试/观察入口使用，不进生产链路）。
 *
 * 明细数据全部取自 retrieveMemory(collectTrace) 的 trace 快照（管线中间产物），
 * 本层只做整形（挑字段 / 排序 / 标记 picked），不做二次计算——「预览看到的」
 * 与「实际注入的」同一来源、不会漂移。
 */

import { RECALL_SECTION_SLOTS } from './embeddings';
import { factRef, sectionRef, type PoolEntry, type RetrieveTrace } from './retrieval';
import type { FactCategory, MemoryData, SectionData } from './types';

export interface FactScoreDetail {
  id: string;
  content: string;
  category: FactCategory;
  confidence: number;
  /** BM25 词面分（无上界，只做同轮相对排序）。 */
  bm25: number;
  /** 向量路余弦；无向量 / 维度不符 / 未过门槛 → null。 */
  cosine: number | null;
  /** 是否由向量路召回（余弦 ≥ 门槛）。 */
  inVectorLeg: boolean;
  /** RRF 融合分；未进候选池 → null。 */
  rrf: number | null;
  /** 倒数排名分（与 RRF 同量纲，可跨条目比较）：池头精排名次、池尾接续名次；
   *  未参与精排 / 精排失败 → null。 */
  rerank: number | null;
  /** provider 原始精排分（分布压缩，仅调试用）；未精排 → null。 */
  rerankRaw: number | null;
  /** 组装排序分 =（rerank ?? RRF）×（0.5 + 0.5×confidence）；未进池 → null。 */
  final: number | null;
  /** 是否进入实际注入集合。 */
  picked: boolean;
}

export interface SectionScoreDetail {
  /** `user.topOfMind` / `history.recentMonths` 等。 */
  ref: string;
  group: 'user' | 'history';
  slot: string;
  summary: string;
  bm25: number;
  cosine: number | null;
  inVectorLeg: boolean;
  rrf: number | null;
  rerank: number | null;
  rerankRaw: number | null;
  /** 池内秩来源分（rerank ?? RRF，同为倒数排名量纲）；未进池 → null。 */
  final: number | null;
  picked: boolean;
}

/** 明细组装结果。 */
export interface RetrievePreviewDetail {
  /** 全部 fact 的明细（含未入选者），按 final 降序。 */
  facts: FactScoreDetail[];
  /** 4 个召回 section 的明细。 */
  sections: SectionScoreDetail[];
}

function sectionAt(data: MemoryData, group: 'user' | 'history', slot: string): SectionData {
  const value = (data[group] as unknown as Record<string, SectionData>)[slot];
  return value ?? { summary: '', updatedAt: '' };
}

/**
 * 打分明细的公共字段：全部取自 trace 的过程值（词面命中 / 向量命中 / 池条目），
 * 明细层不做二次计算——facts 与 sections 明细共用，保证口径一致。
 */
function scoreOf(
  ref: string,
  entry: PoolEntry | undefined,
  bm25ByRef: Map<string, number>,
  vectorHits: Map<string, number>,
): Pick<
  FactScoreDetail,
  'bm25' | 'cosine' | 'inVectorLeg' | 'rrf' | 'rerank' | 'rerankRaw' | 'final'
> {
  return {
    bm25: bm25ByRef.get(ref) ?? 0,
    cosine: vectorHits.get(ref) ?? null,
    inVectorLeg: vectorHits.has(ref),
    rrf: entry?.rrf ?? null,
    rerank: entry?.rerank ?? null,
    rerankRaw: entry?.rerankRaw ?? null,
    final: entry?.final ?? null,
  };
}

/** 由 trace 快照组装全部明细（facts 按 final 降序，含未入选者）。 */
export function buildRetrievalDetail(
  data: MemoryData,
  trace: RetrieveTrace,
): RetrievePreviewDetail {
  const poolByRef = new Map(trace.pool.map((e) => [e.ref, e]));

  const facts: FactScoreDetail[] = (data.facts ?? [])
    .map((f) => {
      const ref = factRef(f.id);
      return {
        id: f.id,
        content: f.content,
        category: f.category,
        confidence: f.confidence,
        ...scoreOf(ref, poolByRef.get(ref), trace.bm25ByRef, trace.vectorHits),
        picked: trace.pickedFactIds.has(f.id),
      };
    })
    .sort((a, b) => (b.final ?? -Infinity) - (a.final ?? -Infinity));

  const sections: SectionScoreDetail[] = RECALL_SECTION_SLOTS.map(([group, slot]) => {
    const section = sectionAt(data, group, slot);
    const ref = sectionRef(group, slot);
    return {
      ref,
      group,
      slot,
      summary: section.summary ?? '',
      ...scoreOf(ref, poolByRef.get(ref), trace.bm25ByRef, trace.vectorHits),
      picked: group === 'user' ? trace.keepTopOfMind : trace.historySlot === slot,
    };
  });

  return { facts, sections };
}
