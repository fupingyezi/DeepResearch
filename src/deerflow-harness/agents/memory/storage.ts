/**
 * Memory storage。
 *
 * 双后端：
 * - FileMemoryStorage：旧文件后端（测试 / 降级）。mtime cache
 *   （key=`${userId}::${agentName}`，None 用空串）、原子写（tmp + rename）、
 *   per-user 分布式锁 RMW。
 * - PgMemoryStorage：PG 后端（见 pg-storage.ts），wiring 侧 `setMemoryStorage()`
 *   注入。jsonb 存结构、memory_vectors 存向量；并发写走 PG 行锁事务，
 *   不依赖本文件的分布式锁。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getDistLock, type DistLockHandle } from '../../runtime/locks/dist-lock';
import { resolveLegacyFilePath, readLegacyMemoryFile } from './legacy-file';
import { MemoryData, utcNowIsoZ } from './types';

/** 记忆锁 TTL：mutator 可能内含 embedding 补齐（批量 API 调用），只兜底持有者崩溃。 */
const MEMORY_LOCK_TTL_MS = 15_000;
/** 记忆锁等待预算：覆盖对方完整走完一次 mutator 的时间。 */
const MEMORY_LOCK_WAIT_MS = 5_000;

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

interface CacheEntry {
  data: MemoryData;
  mtimeMs: number | null;
}

export class FileMemoryStorage implements MemoryStorage {
  /** key: `${userId ?? ''}::${agentName ?? ''}`。 */
  private cache = new Map<string, CacheEntry>();

  private cacheKey(
    agentName: string | null | undefined,
    userId: string | null | undefined,
  ): string {
    return `${userId ?? ''}::${agentName ?? ''}`;
  }

  private async statMtime(filePath: string): Promise<number | null> {
    try {
      const s = await fs.stat(filePath);
      return s.mtimeMs;
    } catch {
      return null;
    }
  }

  private async loadFromFile(filePath: string): Promise<MemoryData> {
    return (await readLegacyMemoryFile(filePath)).data;
  }

  async load(
    opts: { agentName?: string | null; userId?: string | null } = {},
  ): Promise<MemoryData> {
    const { agentName = null, userId = null } = opts;
    const filePath = resolveLegacyFilePath(agentName, userId);
    const key = this.cacheKey(agentName, userId);
    const currentMtime = await this.statMtime(filePath);

    const cached = this.cache.get(key);
    if (cached && cached.mtimeMs === currentMtime) {
      return cached.data;
    }

    const data = await this.loadFromFile(filePath);
    this.cache.set(key, { data, mtimeMs: currentMtime });
    return data;
  }

  async reload(
    opts: { agentName?: string | null; userId?: string | null } = {},
  ): Promise<MemoryData> {
    const { agentName = null, userId = null } = opts;
    const filePath = resolveLegacyFilePath(agentName, userId);
    const key = this.cacheKey(agentName, userId);
    const data = await this.loadFromFile(filePath);
    const mtime = await this.statMtime(filePath);
    this.cache.set(key, { data, mtimeMs: mtime });
    return data;
  }

  async save(
    data: MemoryData,
    opts: { agentName?: string | null; userId?: string | null } = {},
  ): Promise<boolean> {
    // 与 update 同一条锁路径：全量覆盖也是 RMW，不能绕过锁直接写盘
    const updated = await this.update(() => data, opts);
    return updated !== null;
  }

  async update(
    mutator: (current: MemoryData) => Promise<MemoryData> | MemoryData,
    opts: { agentName?: string | null; userId?: string | null } = {},
  ): Promise<MemoryData | null> {
    const { agentName = null, userId = null } = opts;
    const filePath = resolveLegacyFilePath(agentName, userId);
    const key = this.cacheKey(agentName, userId);

    // per-user 锁：同一用户的记忆只允许一个写者。等待期轮询（mutator 内含
    // embedding 补齐，对方持锁可达秒级）；超预算继续执行并告警——锁是防错
    // 而非门禁，最后的残余竞态由原子写保证文件不损坏。
    const handle = await this.acquireMemoryLock(userId);
    try {
      // 锁内直读磁盘（绕开 mtime 缓存）：RMW 的 read 必须看到其它进程的最新写入
      const current = await this.loadFromFile(filePath);
      // mutator 的领域错误（fact 不存在等）原样上抛；只有落盘 IO 失败收敛为 null
      const next = await mutator(current);
      if (next === current) return current;
      try {
        await this.writeToFile(filePath, key, next);
      } catch (e) {
        console.error('[memory/storage] Failed to write memory file:', e);
        return null;
      }
      return next;
    } finally {
      await handle?.release();
    }
  }

  private async acquireMemoryLock(userId: string | null): Promise<DistLockHandle | null> {
    const lock = getDistLock();
    const lockKey = `deerflow:lock:memory:${userId ?? 'global'}`;
    const deadline = Date.now() + MEMORY_LOCK_WAIT_MS;
    for (;;) {
      const handle = await lock.acquire(lockKey, MEMORY_LOCK_TTL_MS);
      if (handle) return handle;
      if (Date.now() >= deadline) {
        console.warn(
          `[memory/storage] memory lock wait timeout key=${lockKey}; proceed without lock`,
        );
        return null;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }

  /** 原子写：临时文件 + rename，任何时刻读文件都不会读到半截 JSON。 */
  private async writeToFile(filePath: string, key: string, data: MemoryData): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // shallow copy + 刷新 lastUpdated（避免直接 mutate 调用方对象）
    const toWrite: MemoryData = { ...data, lastUpdated: utcNowIsoZ() };

    const tmpPath = `${filePath}.${randomUUID().replace(/-/g, '')}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(toWrite, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);

    const mtime = await this.statMtime(filePath);
    this.cache.set(key, { data: toWrite, mtimeMs: mtime });
    if (process.env.MEMORY_DEBUG === '1' || process.env.MEMORY_DEBUG === 'true') {
      console.log(`[memory/storage] Memory saved to ${filePath}`);
    }
  }
}

let _instance: MemoryStorage | null = null;

export function getMemoryStorage(): MemoryStorage {
  if (_instance) return _instance;
  _instance = new FileMemoryStorage();
  return _instance;
}

/** 注入自定义后端（wiring 侧在 pgvector 就绪后切到 PgMemoryStorage）。 */
export function setMemoryStorage(storage: MemoryStorage): void {
  _instance = storage;
}

/** 仅供测试使用：重置单例。 */
export function resetMemoryStorage(): void {
  _instance = null;
}
