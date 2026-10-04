import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_MEMORY_CONFIG, setMemoryConfig } from '../config';
import { resetDistLock } from '../../../runtime/locks/dist-lock';
import { getMemoryStorage, resetMemoryStorage } from '../storage';
import type { MemoryData } from '../types';

/**
 * FileMemoryStorage.update 的 RMW 语义：锁内重读 → mutator → 原子写。
 * 走真实 storage（tmp 文件），锁为进程内实现（测试环境无 REDIS_URL）。
 */

function memory(facts: string[]): MemoryData {
  return {
    version: '1.0',
    lastUpdated: '2026-01-01T00:00:00.000Z',
    user: {
      workContext: { summary: '', updatedAt: '' },
      personalContext: { summary: '', updatedAt: '' },
      topOfMind: { summary: '', updatedAt: '' },
    },
    history: {
      recentMonths: { summary: '', updatedAt: '' },
      earlierContext: { summary: '', updatedAt: '' },
      longTermBackground: { summary: '', updatedAt: '' },
    },
    facts: facts.map((content, i) => ({
      id: `f${i}`,
      content,
      category: 'knowledge',
      confidence: 0.9,
      createdAt: '2026-01-01T00:00:00.000Z',
      source: 'test',
    })),
  };
}

describe('FileMemoryStorage.update', () => {
  let tmpDir: string;
  const scope = { agentName: null, userId: 'u1' };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-update-test-'));
    setMemoryConfig({
      ...DEFAULT_MEMORY_CONFIG,
      storagePath: path.join(tmpDir, 'memory.json'),
    });
    resetMemoryStorage();
    resetDistLock();
  });

  afterEach(async () => {
    resetMemoryStorage();
    resetDistLock();
    setMemoryConfig({ ...DEFAULT_MEMORY_CONFIG });
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('mutator 作用于锁内最新状态：并发两次 update 互不丢写', async () => {
    await getMemoryStorage().save(memory(['a']), scope);

    const add = (content: string) =>
      getMemoryStorage().update(
        (data) => ({
          ...data,
          facts: [
            ...data.facts,
            {
              id: content,
              content,
              category: 'knowledge',
              confidence: 0.9,
              createdAt: '2026-01-01T00:00:00.000Z',
              source: 'test',
            },
          ],
        }),
        scope,
      );

    const [r1, r2] = await Promise.all([add('b'), add('c')]);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();

    const final = await getMemoryStorage().load(scope);
    expect(final.facts.map((f) => f.content).sort()).toEqual(['a', 'b', 'c']);
  });

  it('mutator 返回同一引用 → 跳过写入（lastUpdated 不刷新）', async () => {
    await getMemoryStorage().save(memory(['a']), scope);
    const before = await getMemoryStorage().load(scope);

    const result = await getMemoryStorage().update((data) => data, scope);
    expect(result).not.toBeNull();

    const after = await getMemoryStorage().reload(scope);
    expect(after.lastUpdated).toBe(before.lastUpdated);
    expect(after.facts.map((f) => f.content)).toEqual(['a']);
  });

  it('mutator 抛错原样上抛，且不写盘', async () => {
    await getMemoryStorage().save(memory(['a']), scope);
    const before = await getMemoryStorage().reload(scope);

    await expect(
      getMemoryStorage().update(() => {
        throw new Error('fact not found: nope');
      }, scope),
    ).rejects.toThrow('fact not found: nope');

    const after = await getMemoryStorage().reload(scope);
    expect(after.facts.map((f) => f.content)).toEqual(before.facts.map((f) => f.content));
  });

  it('save 与 update 同一条锁路径：混用也能保证序列化', async () => {
    await getMemoryStorage().save(memory(['a']), scope);
    const ok = await getMemoryStorage().save(memory(['a', 'b']), scope);
    expect(ok).toBe(true);
    const final = await getMemoryStorage().load(scope);
    expect(final.facts.map((f) => f.content)).toEqual(['a', 'b']);
  });
});
