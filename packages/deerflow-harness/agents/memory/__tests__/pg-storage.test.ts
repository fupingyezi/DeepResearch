import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MEMORY_CONFIG, setMemoryConfig } from '../config';
import { PgMemoryStorage } from '../pg-storage';
import { getMemoryDegradeStats, resetMemoryDegradeStats } from '../stats';
import type { Fact, MemoryData, SectionData } from '../types';
import { FakeSql } from './fake-sql';

/**
 * PgMemoryStorage 单元测试：内存假 SQL 执行器模拟两张表（memory_state /
 * memory_vectors）与事务回滚，不依赖真实 PG（真实语义见集成测试）。
 */

const DIMS = 4;

/** 单位向量。 */
function vec(seed: number): number[] {
  const raw = Array.from({ length: DIMS }, (_, i) => (i === 0 ? seed : seed / 2));
  const norm = Math.sqrt(raw.reduce((s, x) => s + x * x, 0));
  return raw.map((x) => x / norm);
}

function memory(facts: Fact[], topOfMind?: Partial<SectionData>): MemoryData {
  return {
    version: '1.0',
    lastUpdated: '2026-01-01T00:00:00.000Z',
    user: {
      workContext: { summary: '', updatedAt: '' },
      personalContext: { summary: '', updatedAt: '' },
      topOfMind: { summary: '', updatedAt: '', ...topOfMind },
    },
    history: {
      recentMonths: { summary: '', updatedAt: '' },
      earlierContext: { summary: '', updatedAt: '' },
      longTermBackground: { summary: '', updatedAt: '' },
    },
    facts,
  };
}

function fact(id: string, content: string, embedding?: number[]): Fact {
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

describe('PgMemoryStorage', () => {
  let sql: FakeSql;
  let storage: PgMemoryStorage;
  const scope = { agentName: null, userId: 'u1' };

  beforeEach(() => {
    setMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, embeddingDimensions: DIMS });
    sql = new FakeSql();
    storage = new PgMemoryStorage(sql);
    resetMemoryDegradeStats();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    setMemoryConfig({ ...DEFAULT_MEMORY_CONFIG });
    vi.restoreAllMocks();
  });

  it('save + load 往返：结构落 jsonb（无 embedding）、向量落 memory_vectors 并在 load 时水合', async () => {
    const data = memory([fact('f1', '用户喜欢 pnpm', vec(1)), fact('f2', '用户做量化研究')], {
      summary: '在筹备婚礼',
      embedding: vec(3),
    });
    const ok = await storage.save(data, scope);
    expect(ok).toBe(true);

    // jsonb 不含 embedding（向量只在 memory_vectors）
    const stored = sql.state.get('u1::')!;
    expect(JSON.stringify(stored.data)).not.toContain('embedding');

    // 向量表：f1 + section（f2 本就没有向量，不写行）
    expect([...sql.vectors.keys()].sort()).toEqual(['u1::|fact|f1', 'u1::|section|user.topOfMind']);

    const loaded = await storage.load(scope);
    expect(loaded.facts.find((f) => f.id === 'f1')?.embedding).toEqual(vec(1));
    expect(loaded.facts.find((f) => f.id === 'f2')?.embedding).toBeUndefined(); // 原本就没有
    expect(loaded.user.topOfMind.embedding).toEqual(vec(3));
  });

  it('load 是单语句快照读：jsonb 与向量聚合在同一条 SELECT 里取回', async () => {
    await storage.save(
      memory([fact('f1', '带向量', vec(1))], { summary: 's', embedding: vec(3) }),
      scope,
    );
    sql.calls.length = 0;

    const loaded = await storage.load(scope);
    expect(loaded.facts.find((f) => f.id === 'f1')?.embedding).toEqual(vec(1));
    expect(loaded.user.topOfMind.embedding).toEqual(vec(3));

    // 拆成两条独立查询会读到「新 jsonb + 旧 vectors」的跨快照错位，
    // 单语句（jsonb_agg 标量子查询聚合）保证同一快照
    const selects = sql.calls.filter((t) => t.trim().startsWith('SELECT'));
    expect(selects).toHaveLength(1);
    expect(selects[0]).toContain('jsonb_agg');
  });

  it('无行 → 返回空 schema，且不插入行', async () => {
    const loaded = await storage.load(scope);
    expect(loaded.facts).toEqual([]);
    expect(loaded.user.topOfMind.summary).toBe('');
    expect(sql.state.size).toBe(0);
    expect(sql.vectors.size).toBe(0);
  });

  it('update 首写无行 scope：先 INSERT 造行再 SELECT FOR UPDATE（防并发首写丢更新）', async () => {
    const result = await storage.update(
      (current) => ({ ...current, facts: [...current.facts, fact('f1', '首写')] }),
      scope,
    );
    expect(result).not.toBeNull();
    expect(result?.facts.map((f) => f.content)).toEqual(['首写']);

    // readLocked 必须先造行再行锁读：直接 FOR UPDATE 时行不存在、锁不住，
    // 两个进程并发首写会同时读空、各自 UPSERT，后提交者覆盖先提交者
    const insertIdx = sql.calls.findIndex((t) => t.trim().startsWith('INSERT INTO memory_state'));
    const forUpdateIdx = sql.calls.findIndex((t) => t.includes('FOR UPDATE'));
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    expect(forUpdateIdx).toBeGreaterThan(insertIdx);
  });

  it('update 的 mutator 前已水合向量：靠 current 里的 embedding 判缺的调用方不会误判', async () => {
    await storage.save(memory([fact('f1', '已有向量', vec(1))]), scope);

    let seenEmbedding: number[] | undefined;
    const result = await storage.update((current) => {
      seenEmbedding = current.facts[0]?.embedding;
      return { ...current, facts: [...current.facts, fact('f2', '新增', vec(2))] };
    }, scope);

    expect(seenEmbedding).toEqual(vec(1)); // 硬约束：jsonb 没有 embedding，靠水合
    expect(result?.facts.map((f) => f.content)).toEqual(['已有向量', '新增']);
  });

  it('update 同引用 → 跳过写入，lastUpdated 不刷新', async () => {
    await storage.save(memory([fact('f1', 'a')]), scope);
    const before = await storage.load(scope);

    const result = await storage.update((data) => data, scope);
    expect(result).not.toBeNull();

    const after = await storage.reload(scope);
    expect(after.lastUpdated).toBe(before.lastUpdated);
    expect(after.facts.map((f) => f.content)).toEqual(['a']);
  });

  it('update 的 mutator 抛错原样上抛（领域错误穿透事务层），且整体回滚', async () => {
    await storage.save(memory([fact('f1', 'a', vec(1))]), scope);

    await expect(
      storage.update(() => {
        throw new Error('fact not found: nope');
      }, scope),
    ).rejects.toThrow('fact not found: nope');

    const after = await storage.reload(scope);
    expect(after.facts.map((f) => f.content)).toEqual(['a']);
    expect(sql.vectors.size).toBe(1); // 无半截写
  });

  it('update 的 SQL 失败 → 返回 null 且整体回滚', async () => {
    await storage.save(memory([fact('f1', 'a')]), scope);

    sql.failNext = new Error('pg down');
    const result = await storage.update(
      (current) => ({ ...current, facts: [...current.facts, fact('f2', 'b')] }),
      scope,
    );

    expect(result).toBeNull();
    const after = await storage.reload(scope);
    expect(after.facts.map((f) => f.content)).toEqual(['a']);
    expect(getMemoryDegradeStats().storageUpdateFailures).toBe(1);
  });

  it('load 失败：健康→故障打一次 warn、故障期静默计数，恢复打 info', async () => {
    // 连续两次失败：warn 只在健康→故障切换时打一次，计数逐次累加
    sql.failNext = new Error('pg down');
    expect((await storage.load(scope)).facts).toEqual([]);
    sql.failNext = new Error('pg down');
    expect((await storage.load(scope)).facts).toEqual([]);

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.info).not.toHaveBeenCalled();
    expect(getMemoryDegradeStats().storageLoadFailures).toBe(2);

    // 恢复：打一次 info，健康态复位（再故障会重新打 warn）
    expect((await storage.load(scope)).facts).toEqual([]);
    expect(console.info).toHaveBeenCalledTimes(1);
  });

  it('update 删除 fact 后向量表同步重建（DELETE + INSERT）', async () => {
    await storage.save(memory([fact('f1', 'a', vec(1)), fact('f2', 'b', vec(2))]), scope);

    await storage.update((current) => ({ ...current, facts: [current.facts[0]] }), scope);

    expect(sql.vectors.has('u1::|fact|f2')).toBe(false);
    expect(sql.vectors.has('u1::|fact|f1')).toBe(true);
    expect(sql.vectors.size).toBe(1);
  });

  it('vectorSearch：按余弦降序返回（含 section），limit 生效', async () => {
    // f_near 与 query 同向（相似 1），f_far 反向（相似 0）
    const q = vec(1);
    await storage.save(
      memory(
        [
          fact('f_near', '近', vec(1)),
          fact('f_mid', '中', [0, 1, 0, 0]),
          fact('f_far', '远', [-1, 0, 0, 0]),
        ],
        { summary: '近 section', embedding: vec(1) },
      ),
      scope,
    );

    const results = await storage.vectorSearch(scope, q, 2);

    expect(results).toHaveLength(2);
    expect(results[0].similarity).toBeCloseTo(1);
    expect(results[0].kind).toBe('fact');
    expect(results[0].refId).toBe('f_near');
    expect(results[1].similarity).toBeCloseTo(1); // section 同向并列，序按表序稳定
    expect(results[1].kind).toBe('section');
    expect(results[1].refId).toBe('user.topOfMind');
  });

  it('vectorSearch 的 SQL 失败原样上抛（检索侧据此回落 JS 扫描）', async () => {
    sql.failNext = new Error('pg down');
    await expect(storage.vectorSearch(scope, vec(1), 10)).rejects.toThrow('pg down');
  });

  it('save 与 update 混用：全量覆盖走同一事务路径', async () => {
    await storage.save(memory([fact('f1', 'a')]), scope);
    const ok = await storage.save(memory([fact('f1', 'a'), fact('f2', 'b')]), scope);
    expect(ok).toBe(true);
    const final = await storage.load(scope);
    expect(final.facts.map((f) => f.content).sort()).toEqual(['a', 'b']);
  });
});
