/**
 * 记忆子系统降级 / 失败计数器（「静默降级」的可观测出口）。
 *
 * 降级（PG 不可用回落空 memory、embedding 失败回落词面、rerank 失败保持
 * RRF 序）的代价是「功能没坏，只是悄悄变弱」——若告警只打一次 warn，生产上
 * 持续降级无从发现。计数器单调累加，与状态切换式日志（健康→故障 warn、
 * 故障→健康 info）配合，监控侧可据数值报警。
 */

export interface MemoryDegradeStats {
  /** PG 记忆读失败次数（load 静默退化为空 memory）。 */
  storageLoadFailures: number;
  /** PG 记忆写失败次数（update 返回 null，本次更新丢失）。 */
  storageUpdateFailures: number;
  /** embedding API 失败次数（语义路回落词面 / 新向量留待回填）。 */
  embedFailures: number;
  /** rerank API 失败次数（精排回落 RRF 序）。 */
  rerankFailures: number;
  /** pgvector 召回失败回落 JS 线性扫描次数。 */
  vectorFallbacks: number;
}

export const memoryDegradeStats: MemoryDegradeStats = {
  storageLoadFailures: 0,
  storageUpdateFailures: 0,
  embedFailures: 0,
  rerankFailures: 0,
  vectorFallbacks: 0,
};

export function getMemoryDegradeStats(): MemoryDegradeStats {
  return { ...memoryDegradeStats };
}

/** 仅供测试。 */
export function resetMemoryDegradeStats(): void {
  memoryDegradeStats.storageLoadFailures = 0;
  memoryDegradeStats.storageUpdateFailures = 0;
  memoryDegradeStats.embedFailures = 0;
  memoryDegradeStats.rerankFailures = 0;
  memoryDegradeStats.vectorFallbacks = 0;
}
