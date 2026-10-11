import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MEMORY_CONFIG, setMemoryConfig } from '../config';
import { InMemoryMemoryStorage } from '../in-memory-storage';
import { createEmptyMemory, type Fact, type MemoryData } from '../types';

const DIMS = 4;

function fact(content: string, id = content, embedding?: number[]): Fact {
  return {
    id,
    content,
    category: 'knowledge',
    confidence: 0.9,
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'test',
    ...(embedding ? { embedding } : {}),
  };
}

describe('InMemoryMemoryStorage', () => {
  afterEach(() => {
    vi.useRealTimers();
    setMemoryConfig({ ...DEFAULT_MEMORY_CONFIG });
  });

  it('save/reload 往返；缺失 scope 返回空 schema', async () => {
    const storage = new InMemoryMemoryStorage();
    const scope = { userId: 'u1', agentName: 'lead' };

    expect((await storage.load(scope)).facts).toEqual([]);

    const data = { ...createEmptyMemory(), facts: [fact('用户住在深圳')] };
    expect(await storage.save(data, scope)).toBe(true);
    const reloaded = await storage.reload(scope);
    expect(reloaded.facts.map((f) => f.content)).toEqual(['用户住在深圳']);
  });

  it('scope 隔离：{userId, agentName} 组合键', async () => {
    const storage = new InMemoryMemoryStorage();
    await storage.save({ ...createEmptyMemory(), facts: [fact('A')] }, { userId: 'u1' });
    await storage.save({ ...createEmptyMemory(), facts: [fact('B')] }, { userId: 'u2' });
    await storage.save(
      { ...createEmptyMemory(), facts: [fact('C')] },
      { userId: 'u1', agentName: 'sub' },
    );

    expect((await storage.reload({ userId: 'u1' })).facts[0].content).toBe('A');
    expect((await storage.reload({ userId: 'u2' })).facts[0].content).toBe('B');
    expect((await storage.reload({ userId: 'u1', agentName: 'sub' })).facts[0].content).toBe('C');
    expect((await storage.reload({ userId: 'u1', agentName: null })).facts[0].content).toBe('A');
  });

  it('update：mutator 收到当前值；新对象落盘并刷新 lastUpdated', async () => {
    const storage = new InMemoryMemoryStorage();
    const scope = { userId: 'u1', agentName: null };
    await storage.save(createEmptyMemory(), scope);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-02-02T02:02:02.000Z'));
      let seen: MemoryData | undefined;
      const updated = await storage.update((current) => {
        seen = current;
        return { ...current, facts: [fact('新增')] };
      }, scope);

      expect(seen!.facts).toEqual([]); // mutator 收到的是当前存储值
      expect(updated).not.toBeNull();
      expect(updated!.lastUpdated).toBe('2026-02-02T02:02:02.000Z');
      expect((await storage.reload(scope)).facts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('update 同引用：跳过写入且不刷新 lastUpdated', async () => {
    const storage = new InMemoryMemoryStorage();
    const scope = { userId: 'u1', agentName: null };
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      await storage.save(createEmptyMemory(), scope);
      const before = await storage.reload(scope);
      vi.setSystemTime(new Date('2026-02-02T00:00:00.000Z'));

      const updated = await storage.update((current) => current, scope);
      expect(updated).not.toBeNull();
      expect(updated!.lastUpdated).toBe(before.lastUpdated); // 未刷新
      expect((await storage.reload(scope)).lastUpdated).toBe(before.lastUpdated); // 未写入
    } finally {
      vi.useRealTimers();
    }
  });

  it('update mutator 抛错原样上抛，存储不被污染', async () => {
    const storage = new InMemoryMemoryStorage();
    const scope = { userId: 'u1', agentName: null };
    const error = new Error('fact not found');
    await storage.save({ ...createEmptyMemory(), facts: [fact('既有')] }, scope);

    await expect(
      storage.update(() => {
        throw error;
      }, scope),
    ).rejects.toBe(error);
    expect((await storage.reload(scope)).facts.map((f) => f.content)).toEqual(['既有']);
  });

  it('vectorSearch：fact id / `group.slot` refId 口径 + 余弦降序', async () => {
    const storage = new InMemoryMemoryStorage();
    const scope = { userId: 'u1', agentName: null };
    const query = [1, 0, 0, 0];
    await storage.save(
      {
        ...createEmptyMemory(),
        user: {
          ...createEmptyMemory().user,
          topOfMind: { summary: '正交槽位', updatedAt: '', embedding: [0, 1, 0, 0] },
        },
        facts: [fact('强相关', 'f_strong', query), fact('不相关', 'f_weak', [0, 1, 0, 0])],
      },
      scope,
    );

    const hits = await storage.vectorSearch(scope, query, 10);
    // 同分（正交 = 0）下稳定排序保持收集顺序：fact 先于 section
    expect(hits.map((h) => h.refId)).toEqual(['f_strong', 'f_weak', 'user.topOfMind']);
    expect(hits[0]).toEqual({ kind: 'fact', refId: 'f_strong', similarity: 1 });
    expect(hits[1].similarity).toBeCloseTo(0);
  });

  it('写时归一：非单位向量落盘即单位；容差内原样保留', async () => {
    setMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, embeddingDimensions: DIMS });
    const storage = new InMemoryMemoryStorage();
    const scope = { userId: 'u1', agentName: null };
    const raw = [2, 1, 1, 1]; // 非单位
    const nearlyUnit = [0.5, 0.5, 0.5, 0.5].map((x) => x * 1.000001); // 容差内
    await storage.save(
      { ...createEmptyMemory(), facts: [fact('a', 'f_raw', raw), fact('b', 'f_near', nearlyUnit)] },
      scope,
    );

    const reloaded = await storage.reload(scope);
    const norm = Math.sqrt(7);
    expect(reloaded.facts.find((f) => f.id === 'f_raw')?.embedding).toEqual([
      2 / norm,
      1 / norm,
      1 / norm,
      1 / norm,
    ]);
    expect(reloaded.facts.find((f) => f.id === 'f_near')?.embedding).toEqual(nearlyUnit);
  });
});
