/**
 * Memory storage。
 *
 * 关键特性：
 * - mtime cache（key=`{userId}::{agentName}`，None 用空串）。
 * - 原子写：写入临时文件后 `rename`。
 * - JSON 损坏 / IO 失败时回退到空 schema。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getDistLock, type DistLockHandle } from '../../runtime/locks/dist-lock';
import { getMemoryConfig } from './config';
import {
  agentMemoryFile,
  getBaseDir,
  memoryFile,
  userAgentMemoryFile,
  userMemoryFile,
} from './paths';
import { createEmptyMemory, MemoryData, SectionData, utcNowIsoZ, validateAgentName } from './types';

/** 记忆锁 TTL：mutator 可能内含 embedding 补齐（批量 API 调用），只兜底持有者崩溃。 */
const MEMORY_LOCK_TTL_MS = 15_000;
/** 记忆锁等待预算：覆盖对方完整走完一次 mutator 的时间。 */
const MEMORY_LOCK_WAIT_MS = 5_000;

export interface MemoryStorage {
  load(opts?: { agentName?: string | null; userId?: string | null }): Promise<MemoryData>;
  reload(opts?: { agentName?: string | null; userId?: string | null }): Promise<MemoryData>;
  save(
    data: MemoryData,
    opts?: { agentName?: string | null; userId?: string | null },
  ): Promise<boolean>;
  /**
   * 加锁的 read-modify-write：per-user 锁内重读磁盘 → 应用 mutator → 原子写。
   * mutator 返回同一引用视为无变更，跳过写入；mutator 抛错原样上抛（领域错误
   * 与 IO 失败区分开），IO 失败返回 null。
   */
  update(
    mutator: (current: MemoryData) => Promise<MemoryData> | MemoryData,
    opts?: { agentName?: string | null; userId?: string | null },
  ): Promise<MemoryData | null>;
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

  private resolveFilePath(
    agentName: string | null | undefined,
    userId: string | null | undefined,
  ): string {
    if (userId) {
      if (agentName) {
        validateAgentName(agentName);
        return userAgentMemoryFile(userId, agentName);
      }
      const config = getMemoryConfig();
      if (config.storagePath && path.isAbsolute(config.storagePath)) {
        return config.storagePath;
      }
      return userMemoryFile(userId);
    }

    // 全局 memory（无 userId 隔离场景）
    if (agentName) {
      validateAgentName(agentName);
      return agentMemoryFile(agentName);
    }

    const config = getMemoryConfig();
    if (config.storagePath) {
      return path.isAbsolute(config.storagePath)
        ? config.storagePath
        : path.join(getBaseDir(), config.storagePath);
    }
    return memoryFile();
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
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (e: any) {
      // 文件不存在视为空 memory；其余 IO 错误同样回退
      if (e?.code !== 'ENOENT') {
        console.warn('[memory/storage] Failed to read memory file:', e);
      }
      return createEmptyMemory();
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return createEmptyMemory();
      // 容错：缺字段时自动补齐为空 schema 字段（不破坏旧数据）
      return mergeWithEmpty(parsed);
    } catch (e) {
      console.warn('[memory/storage] Failed to parse memory file:', e);
      return createEmptyMemory();
    }
  }

  async load(
    opts: { agentName?: string | null; userId?: string | null } = {},
  ): Promise<MemoryData> {
    const { agentName = null, userId = null } = opts;
    const filePath = this.resolveFilePath(agentName, userId);
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
    const filePath = this.resolveFilePath(agentName, userId);
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
    const filePath = this.resolveFilePath(agentName, userId);
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

/** 把磁盘上可能缺字段的 JSON 合并到空 schema，保证下游字段安全。 */
function mergeWithEmpty(parsed: any): MemoryData {
  const empty = createEmptyMemory();
  const merged: MemoryData = {
    version: parsed.version === '1.0' ? '1.0' : '1.0',
    lastUpdated: typeof parsed.lastUpdated === 'string' ? parsed.lastUpdated : empty.lastUpdated,
    user: {
      workContext: mergeSection(parsed?.user?.workContext, empty.user.workContext),
      personalContext: mergeSection(parsed?.user?.personalContext, empty.user.personalContext),
      topOfMind: mergeSection(parsed?.user?.topOfMind, empty.user.topOfMind),
    },
    history: {
      recentMonths: mergeSection(parsed?.history?.recentMonths, empty.history.recentMonths),
      earlierContext: mergeSection(parsed?.history?.earlierContext, empty.history.earlierContext),
      longTermBackground: mergeSection(
        parsed?.history?.longTermBackground,
        empty.history.longTermBackground,
      ),
    },
    facts: Array.isArray(parsed.facts)
      ? parsed.facts
          .filter((f: any) => f && typeof f === 'object')
          .map((f: any) => sanitizeLoadedFact(f))
      : [],
  };
  return merged;
}

/**
 * 结构非法的 embedding（非数组 / 含非有限数）直接剥除，避免污染检索侧。
 * 维度不匹配的合法向量保留（由检索 / 回填按 config 维度判定失效并重算）。
 */
function sanitizeLoadedFact(f: any): any {
  if (f.embedding != null) {
    const v: unknown = f.embedding;
    const ok = Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x));
    if (!ok) delete f.embedding;
  }
  return f;
}

/**
 * section 合并：保留 summary/updatedAt 与合法的 embedding 向量。
 * 向量口径与 sanitizeLoadedFact 一致——非数组 / 含非有限数剥除；维度不符的
 * 合法向量保留，由检索 / 回填按 config 维度判定失效并重算。
 */
function mergeSection(s: any, dft: SectionData): SectionData {
  if (!s || typeof s !== 'object') return { ...dft };
  const out: SectionData = {
    summary: typeof s.summary === 'string' ? s.summary : dft.summary,
    updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : dft.updatedAt,
  };
  if (
    Array.isArray(s.embedding) &&
    s.embedding.every((x: unknown) => typeof x === 'number' && Number.isFinite(x))
  ) {
    out.embedding = s.embedding as number[];
  }
  return out;
}

let _instance: MemoryStorage | null = null;

export function getMemoryStorage(): MemoryStorage {
  if (_instance) return _instance;
  _instance = new FileMemoryStorage();
  return _instance;
}

/** 仅供测试使用：重置单例。 */
export function resetMemoryStorage(): void {
  _instance = null;
}
