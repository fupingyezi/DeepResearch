/**
 * Memory storage。
 *
 * 单后端：PgMemoryStorage（见 pg-storage.ts），wiring 侧 `setMemoryStorage()`
 * 注入。jsonb 存结构、memory_vectors 存向量；并发写走 PG 行锁事务。
 *
 * 注册表默认是 NoopMemoryStorage：PG 尚未装配（或装配失败）期间记忆功能关闭
 * ——load 返回空 schema、写操作静默放弃，不抛错不阻断聊天。
 */

import { createEmptyMemory } from './types';
import type { MemoryData } from './types';

/**
 * harness 侧的最小 SQL 接口（query + transaction），由 app 层包装 @/lib/db 的
 * 连接池注入（模式同 checkpointer/factory）。harness 不反向依赖 app 层，
 * 也不依赖 pg 驱动的具体类型。
 */
export interface MemorySqlExecutor {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  /** BEGIN/COMMIT/ROLLBACK 语义；fn 抛错时自动回滚并原样上抛。不支持嵌套。 */
  transaction<T>(fn: (tx: MemorySqlExecutor) => Promise<T>): Promise<T>;
}

/** pgvector 向量召回结果（按余弦相似度降序）。 */
export interface VectorSearchResult {
  kind: 'fact' | 'section';
  /** fact 为 fact id；section 为 `<group>.<slot>`（如 `user.topOfMind`）。 */
  refId: string;
  /** 余弦相似度 0..1（存库向量已 L2 归一，`1 - <=>` 即余弦）。 */
  similarity: number;
}

export interface MemoryStorage {
  load(opts?: { agentName?: string | null; userId?: string | null }): Promise<MemoryData>;
  reload(opts?: { agentName?: string | null; userId?: string | null }): Promise<MemoryData>;
  save(
    data: MemoryData,
    opts?: { agentName?: string | null; userId?: string | null },
  ): Promise<boolean>;
  /**
   * 加锁的 read-modify-write：锁内重读最新状态 → 应用 mutator → 原子写。
   * mutator 返回同一引用视为无变更，跳过写入；mutator 抛错原样上抛（领域错误
   * 与 IO 失败区分开），IO 失败返回 null。
   */
  update(
    mutator: (current: MemoryData) => Promise<MemoryData> | MemoryData,
    opts?: { agentName?: string | null; userId?: string | null },
  ): Promise<MemoryData | null>;
  /**
   * pgvector 向量召回（可选能力）：仅 PG 后端实现；未实现 / 实现抛错时
   * 检索侧回落 JS 余弦线性扫描。limit 为召回条数上限（fact + section 混排）。
   */
  vectorSearch?(
    opts: { agentName?: string | null; userId?: string | null },
    queryVector: number[],
    limit: number,
  ): Promise<VectorSearchResult[]>;
}

/**
 * PG 未装配时的占位后端：记忆功能整体关闭。
 * load/reload 返回空 schema（语义检索自然全部落空、不注入）；
 * save/update 放弃写入返回失败值——与 PG 故障口径一致，调用方照常容错。
 */
class NoopMemoryStorage implements MemoryStorage {
  async load(): Promise<MemoryData> {
    return createEmptyMemory();
  }
  async reload(): Promise<MemoryData> {
    return createEmptyMemory();
  }
  async save(): Promise<boolean> {
    return false;
  }
  async update(): Promise<MemoryData | null> {
    return null;
  }
}

let _instance: MemoryStorage | null = null;

export function getMemoryStorage(): MemoryStorage {
  return _instance ?? new NoopMemoryStorage();
}

/** 注入后端（wiring 侧在 pgvector 就绪后切到 PgMemoryStorage）。 */
export function setMemoryStorage(storage: MemoryStorage): void {
  _instance = storage;
}

/** 仅供测试使用：重置单例。 */
export function resetMemoryStorage(): void {
  _instance = null;
}
