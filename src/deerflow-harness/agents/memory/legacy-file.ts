/**
 * 旧文件后端的纯函数：路径解析 + 磁盘读取/容错合并。
 *
 * FileMemoryStorage（读）与 PgMemoryStorage（懒迁移）共用——文件与 PG 两条
 * 路径对「路径怎么定」「坏 JSON 怎么容错」「哪些字段怎么补」必须同一口径，
 * 否则同一份 memory.json 在两个后端眼里是不同的数据。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getMemoryConfig } from './config';
import {
  agentMemoryFile,
  getBaseDir,
  memoryFile,
  userAgentMemoryFile,
  userMemoryFile,
} from './paths';
import { createEmptyMemory, MemoryData, SectionData, validateAgentName } from './types';

/** 解析某 scope 的旧文件路径（与 FileMemoryStorage 历史行为逐字一致）。 */
export function resolveLegacyFilePath(
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

export interface LegacyFileRead {
  /** 文件是否存在（PG 懒迁移据此决定要不要插入行）。 */
  exists: boolean;
  /** 读取结果；不存在 / IO 失败 / JSON 损坏一律回落空 schema（与文件后端口径一致）。 */
  data: MemoryData;
}

/** 读旧文件并容错合并；`exists` 单独给出，供懒迁移区分「没数据」与「有空文件」。 */
export async function readLegacyMemoryFile(filePath: string): Promise<LegacyFileRead> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (e: any) {
    // 文件不存在视为空 memory；其余 IO 错误同样回退
    if (e?.code !== 'ENOENT') {
      console.warn('[memory/storage] Failed to read memory file:', e);
    }
    return { exists: false, data: createEmptyMemory() };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { exists: true, data: createEmptyMemory() };
    }
    // 容错：缺字段时自动补齐为空 schema 字段（不破坏旧数据）
    return { exists: true, data: mergeWithEmpty(parsed) };
  } catch (e) {
    console.warn('[memory/storage] Failed to parse memory file:', e);
    return { exists: true, data: createEmptyMemory() };
  }
}

/** 把磁盘上可能缺字段的 JSON 合并到空 schema，保证下游字段安全。 */
export function mergeWithEmpty(parsed: any): MemoryData {
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
