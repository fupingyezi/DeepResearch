/**
 * Memory storage。
 *
 * 关键特性：
 * - mtime cache（key=`{userId}::{agentName}`，None 用空串）。
 * - 原子写：写入临时文件后 `rename`。
 * - JSON 损坏 / IO 失败时回退到空 schema（与 Python 一致）。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getMemoryConfig } from './config';
import {
  agentMemoryFile,
  getBaseDir,
  memoryFile,
  userAgentMemoryFile,
  userMemoryFile,
} from './paths';
import { createEmptyMemory, MemoryData, utcNowIsoZ, validateAgentName } from './types';

export interface MemoryStorage {
  load(opts?: { agentName?: string | null; userId?: string | null }): Promise<MemoryData>;
  reload(opts?: { agentName?: string | null; userId?: string | null }): Promise<MemoryData>;
  save(
    data: MemoryData,
    opts?: { agentName?: string | null; userId?: string | null },
  ): Promise<boolean>;
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
      // 文件不存在视为空 memory；其余 IO 错误同样回退（与 Python 行为一致）。
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
    const { agentName = null, userId = null } = opts;
    const filePath = this.resolveFilePath(agentName, userId);
    const key = this.cacheKey(agentName, userId);

    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      // shallow copy + 刷新 lastUpdated（避免直接 mutate 调用方对象）
      const toWrite: MemoryData = { ...data, lastUpdated: utcNowIsoZ() };

      const tmpPath = `${filePath}.${randomUUID().replace(/-/g, '')}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(toWrite, null, 2), 'utf-8');
      await fs.rename(tmpPath, filePath);

      const mtime = await this.statMtime(filePath);
      this.cache.set(key, { data: toWrite, mtimeMs: mtime });
      console.log(`[memory/storage] Memory saved to ${filePath}`);
      return true;
    } catch (e) {
      console.error('[memory/storage] Failed to save memory file:', e);
      return false;
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
      ? parsed.facts.filter((f: any) => f && typeof f === 'object')
      : [],
  };
  return merged;
}

function mergeSection(s: any, dft: { summary: string; updatedAt: string }) {
  if (!s || typeof s !== 'object') return { ...dft };
  return {
    summary: typeof s.summary === 'string' ? s.summary : dft.summary,
    updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : dft.updatedAt,
  };
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
