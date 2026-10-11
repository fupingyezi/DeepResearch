/**
 * InMemoryMemoryStorage —— MemoryStorage 的内存实现（SDK 开箱即用后端 / 测试夹具）。
 *
 * 语义与 PgMemoryStorage 对齐（LangGraph InMemorySaver 模式）：
 * - scope 键同口径：`${userId}::${agentName}`（与 pg 的 scope_key 一致）。
 * - 写时归一：fact 与召回槽位（RECALL_SECTION_SLOTS 四个打分 section）的向量
 *   按 isUnitVector 判等，非单位向量先 L2 归一再落——与 pg collectVectorRows /
 *   toUnitVector 同口径，「存量非单位向量原地归一」语义在内存后端同样成立
 *   （isUnitVector 容差内原样保留，不重复归一）。
 * - update 同引用跳过：mutator 返回 current 视为无变更，不落盘、lastUpdated
 *   不刷新（与 pg 的 `next === current` 判等一致）。
 * - lastUpdated 仅写入路径刷新（utcNowIsoZ）。
 * - vectorSearch 必须实现：injection.ts 检测 storage.vectorSearch 存在即走语义
 *   检索，缺失会让 retrieve 模式静默退化词面；这里复用 vectorRecallJs 兜底路径
 *   （与 pgvector SQL 路径同口径：fact refId = id、section refId = `group.slot`）。
 * - 快照拷贝语义：load/reload/update 出口均为独立拷贝（与 pg 每次读库新解析
 *   一致——调用方原地修改返回值不影响存储，读方别名也不会污染存储；JSON 往返
 *   抹掉 undefined 键，与 pg jsonb 序列化口径一致）。
 * - 无事务概念：mutator 抛错原样上抛（无中间态可回滚）；无 IO 失败路径，
 *   update 恒不返回 null。
 */

import { getMemoryConfig } from './config';
import {
  isCompatibleVector,
  isUnitVector,
  normalizeVector,
  RECALL_SECTION_SLOTS,
} from './embeddings';
import { vectorRecallJs } from './retrieval';
import type { MemoryStorage, VectorSearchResult } from './storage';
import { createEmptyMemory, utcNowIsoZ, type MemoryData, type SectionData } from './types';

/** scope 键与 PgMemoryStorage 同口径（`${userId}::${agentName}`）。 */
function scopeKey(opts: { agentName?: string | null; userId?: string | null }): string {
  return `${opts.userId ?? ''}::${opts.agentName ?? ''}`;
}

/** 快照拷贝：MemoryData 全 JSON 安全类型，往返即深拷贝（见文件头注释）。 */
function cloneData(data: MemoryData): MemoryData {
  return JSON.parse(JSON.stringify(data)) as MemoryData;
}

/** 非单位向量先归一（与 pg-storage 的 toUnitVector 同口径）。 */
function toUnitVector(v: number[]): number[] {
  return isUnitVector(v) ? v : normalizeVector(v);
}

export class InMemoryMemoryStorage implements MemoryStorage {
  private readonly store = new Map<string, MemoryData>();

  async load(
    opts: { agentName?: string | null; userId?: string | null } = {},
  ): Promise<MemoryData> {
    const stored = this.store.get(scopeKey(opts));
    return stored ? cloneData(stored) : createEmptyMemory();
  }

  async reload(
    opts: { agentName?: string | null; userId?: string | null } = {},
  ): Promise<MemoryData> {
    // 无独立缓存：load 与 reload 语义相同
    return this.load(opts);
  }

  async save(
    data: MemoryData,
    opts: { agentName?: string | null; userId?: string | null } = {},
  ): Promise<boolean> {
    const updated = await this.update(() => data, opts);
    return updated !== null;
  }

  async update(
    mutator: (current: MemoryData) => Promise<MemoryData> | MemoryData,
    opts: { agentName?: string | null; userId?: string | null } = {},
  ): Promise<MemoryData | null> {
    const key = scopeKey(opts);
    // 交 mutator 的是独立拷贝：原地修改后返回（next === current）与 pg 同语义
    // 判为无变更，不落盘
    const stored = this.store.get(key);
    const current = stored ? cloneData(stored) : createEmptyMemory();
    const next = await mutator(current);
    if (next === current) return current;
    // shallow copy + 写时归一 + 刷新 lastUpdated（避免直接 mutate 调用方对象）
    const toWrite: MemoryData = this.normalizeVectors({
      ...next,
      lastUpdated: utcNowIsoZ(),
    });
    this.store.set(key, toWrite);
    return toWrite;
  }

  async vectorSearch(
    opts: { agentName?: string | null; userId?: string | null },
    queryVector: number[],
    limit: number,
  ): Promise<VectorSearchResult[]> {
    // 存库向量已写时归一，JS 余弦扫描与 pgvector 的 `1 - <=>` 同量纲
    return vectorRecallJs(await this.load(opts), queryVector, limit);
  }

  /** 写时归一：fact 与四个召回槽位的非单位向量 L2 归一（口径对齐 pg 的
   *  collectVectorRows：summary 非空 + 维度合法才归一；恒保留段与空槽不触碰）。 */
  private normalizeVectors(data: MemoryData): MemoryData {
    const dims = getMemoryConfig().embeddingDimensions;
    let changed = false;

    const facts = data.facts.map((f) => {
      if (!isCompatibleVector(f.embedding, dims)) return f;
      const normalized = toUnitVector(f.embedding);
      if (normalized === f.embedding) return f;
      changed = true;
      return { ...f, embedding: normalized };
    });

    const user = { ...data.user };
    const history = { ...data.history };
    for (const [group, slot] of RECALL_SECTION_SLOTS) {
      const section = ((group === 'user' ? user : history) as Record<string, SectionData>)[slot];
      if (!section?.summary || !isCompatibleVector(section.embedding, dims)) continue;
      const normalized = toUnitVector(section.embedding);
      if (normalized === section.embedding) continue;
      changed = true;
      ((group === 'user' ? user : history) as Record<string, SectionData>)[slot] = {
        ...section,
        embedding: normalized,
      };
    }

    if (!changed) return data;
    return { ...data, user, history, facts };
  }
}
