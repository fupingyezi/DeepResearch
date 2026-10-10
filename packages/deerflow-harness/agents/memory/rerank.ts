/**
 * Memory rerank（RAG 精排的 harness 封装层）。
 *
 * 职责边界：
 * - 适配层（src/lib/zhipu-rerank.ts）fail-fast：非 2xx / 响应畸形直接抛错；
 * - 本封装层静默降级：工厂缺失 / 构造失败 / API 失败 → 计数 + 返回 null，
 *   调用方（检索管线）据此保持 RRF 序继续——与本项目「降级不炸」惯例一致，
 *   是相对 obsidian-rag fail-fast 路线的刻意差异点（那边是评测工具，这边是产品链路）。
 *   告警是状态切换式（健康→故障 warn、故障→健康 info），故障期内计数
 *   进 memoryDegradeStats，持续降级不会淹没在一条 warnOnce 里。
 *
 * 分数语义：zhipu rerank 的 relevance_score 分布高度压缩（不相关也常 0.99+），
 * 只做**相对排序**用，绝不当「相关/不相关」的绝对阈值。
 */

import { memoryDegradeStats } from './stats';

export interface MemoryReranker {
  /** 对 docs 按与 query 的相关性打分；返回与 docs 等长的分数数组（按 index 对齐）。 */
  rerank(query: string, docs: string[]): Promise<number[]>;
}

export type MemoryRerankerFactory = () => MemoryReranker | null;

let _factory: MemoryRerankerFactory | null = null;
let warnedRerankFailure = false;

function warnRerankOnce(stage: string, e: unknown): void {
  memoryDegradeStats.rerankFailures += 1;
  if (warnedRerankFailure) return;
  warnedRerankFailure = true;
  console.warn(`[memory/rerank] ${stage} failed (keeping RRF order):`, e);
}

/** 精排成功 → 故障标记复位，再失败会重新打 warn。 */
function markRerankHealthy(): void {
  if (!warnedRerankFailure) return;
  warnedRerankFailure = false;
  console.info('[memory/rerank] rerank recovered');
}

export function setMemoryRerankerFactory(factory: MemoryRerankerFactory | null): void {
  _factory = factory;
}

export function getMemoryRerankerFactory(): MemoryRerankerFactory | null {
  return _factory;
}

/** 仅供测试使用：重置工厂与告警标志。 */
export function resetMemoryRerankerFactory(): void {
  _factory = null;
  warnedRerankFailure = false;
}

/**
 * rerank + 静默降级：任何失败返回 null（调用方保持 RRF 序）。docs ≤ 1 无需排序，
 * 短路返回全 1（省一次 API 调用）。返回的分数数组只作相对排序用。
 */
export async function rerankWithFallback(query: string, docs: string[]): Promise<number[] | null> {
  if (docs.length <= 1) return docs.map(() => 1);
  const factory = _factory;
  if (!factory) return null;
  let reranker: MemoryReranker | null;
  try {
    reranker = factory();
  } catch (e) {
    warnRerankOnce('factory', e);
    return null;
  }
  if (!reranker) return null;
  try {
    const scores = await reranker.rerank(query, docs);
    // 长度对不上会静默造出乱序：视为失败回落，而不是拿错位分数继续排
    if (!Array.isArray(scores) || scores.length !== docs.length) {
      warnRerankOnce(
        'score-length',
        new Error(
          `expected ${docs.length} scores, got ${Array.isArray(scores) ? scores.length : 'non-array'}`,
        ),
      );
      return null;
    }
    markRerankHealthy();
    return scores;
  } catch (e) {
    warnRerankOnce('rerank', e);
    return null;
  }
}
