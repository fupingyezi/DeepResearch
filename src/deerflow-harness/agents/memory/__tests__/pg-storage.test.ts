import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MEMORY_CONFIG, setMemoryConfig } from '../config';
import { cosineSimilarity } from '../embeddings';
import { PgMemoryStorage } from '../pg-storage';
import type { MemorySqlExecutor } from '../storage';
import type { Fact, MemoryData, SectionData } from '../types';

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

/** 内存假执行器：按 SQL 前缀路由到两张 Map 表，transaction 快照回滚。 */
class FakeSql implements MemorySqlExecutor {
  state = new Map<string, Record<string, unknown>>();
  vectors = new Map<string, number[]>(); // `${scope}|${kind}|${ref}`
  calls: string[] = [];
  /** 注入一次性失败。 */
  failNext: Error | null = null;
  /** INSERT INTO memory_state 判定前钩子：模拟并发方抢先插入。 */
  onInsertState: (() => void) | null = null;

  private vecKey(scope: string, kind: string, ref: string): string {
    return `${scope}|${kind}|${ref}`;
  }

  async query(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    this.calls.push(text);
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    // 真实 SQL 模板字面量带前导换行/缩进，先 trim 再匹配
    const t = text.trim();

    if (t.startsWith('SELECT data FROM memory_state')) {
      const row = this.state.get(String(params[0]));
      return { rows: row ? [{ data: row.data }] : [], rowCount: null };
    }

    if (t.startsWith('INSERT INTO memory_state')) {
      const key = String(params[0]);
      this.onInsertState?.();
      if (t.includes('DO NOTHING') && this.state.has(key)) {
        return { rows: [], rowCount: 0 };
      }
      this.state.set(key, { data: JSON.parse(String(params[3])) });
      return { rows: [], rowCount: 1 };
    }

    if (t.includes('embedding::text AS embedding')) {
      const scope = String(params[0]);
      const rows = [...this.vectors.entries()]
        .filter(([k]) => k.startsWith(`${scope}|`))
        .map(([k, v]) => {
          const [, kind, ref] = k.split('|');
          return { kind, ref_id: ref, embedding: JSON.stringify(v) };
        });
      return { rows, rowCount: rows.length };
    }

    if (t.startsWith('DELETE FROM memory_vectors')) {
      const scope = String(params[0]);
      let n = 0;
      for (const k of [...this.vectors.keys()]) {
        if (k.startsWith(`${scope}|`)) {
          this.vectors.delete(k);
          n += 1;
        }
      }
      return { rows: [], rowCount: n };
    }

    if (t.startsWith('INSERT INTO memory_vectors')) {
      let n = 0;
      for (let i = 0; i < params.length; i += 4) {
        const [scope, kind, ref, vecJson] = params.slice(i, i + 4);
        const k = this.vecKey(String(scope), String(kind), String(ref));
        if (this.vectors.has(k)) continue;
        this.vectors.set(k, JSON.parse(String(vecJson)) as number[]);
        n += 1;
      }
      return { rows: [], rowCount: n };
    }

    if (text.includes('AS similarity')) {
      const queryVector = JSON.parse(String(params[0])) as number[];
      const scope = String(params[1]);
      const limit = Number(params[2]);
      const rows = [...this.vectors.entries()]
        .filter(([k]) => k.startsWith(`${scope}|`))
        .map(([k, v]) => {
          const [, kind, ref] = k.split('|');
          return { kind, ref_id: ref, similarity: cosineSimilarity(queryVector, v) };
        })
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
      return { rows, rowCount: rows.length };
    }

    throw new Error(`FakeSql: unrecognized query: ${text}`);
  }

  async transaction<T>(fn: (tx: MemorySqlExecutor) => Promise<T>): Promise<T> {
    const snapState = new Map(this.state);
    const snapVectors = new Map(this.vectors);
    try {
      return await fn(this);
    } catch (e) {
      // 回滚语义：失败恢复快照
      this.state = snapState;
      this.vectors = snapVectors;
      throw e;
    }
  }
}

describe('PgMemoryStorage', () => {
  let tmpDir: string;
  let sql: FakeSql;
  let storage: PgMemoryStorage;
  const scope = { agentName: null, userId: 'u1' };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-pg-test-'));
    setMemoryConfig({
      ...DEFAULT_MEMORY_CONFIG,
      storagePath: path.join(tmpDir, 'memory.json'),
      embeddingDimensions: DIMS,
    });
    sql = new FakeSql();
    storage = new PgMemoryStorage(sql);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    setMemoryConfig({ ...DEFAULT_MEMORY_CONFIG });
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
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

  it('无行且无旧文件 → 返回空 schema，且不插入行', async () => {
    const loaded = await storage.load(scope);
    expect(loaded.facts).toEqual([]);
    expect(loaded.user.topOfMind.summary).toBe('');
    expect(sql.state.size).toBe(0);
    expect(sql.vectors.size).toBe(0);
  });

  it('懒迁移：旧文件存在 → 插入行 + 向量，文件原样保留', async () => {
    const legacy = memory([fact('f_legacy', '旧文件事实', vec(7))]);
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'memory.json'), JSON.stringify(legacy), 'utf-8');

    const loaded = await storage.load(scope);

    expect(sql.state.has('u1::')).toBe(true);
    expect(sql.vectors.has('u1::|fact|f_legacy')).toBe(true);
    expect(loaded.facts[0]?.content).toBe('旧文件事实');
    expect(loaded.facts[0]?.embedding).toEqual(vec(7));
    // 只读不删：旧文件还在
    const raw = await fs.readFile(path.join(tmpDir, 'memory.json'), 'utf-8');
    expect(raw).toContain('旧文件事实');
  });

  it('懒迁移并发冲突：INSERT 被抢先 → 采用赢家的行，不重复插向量', async () => {
    const legacy = memory([fact('f_legacy', '旧文件事实', vec(7))]);
    await fs.writeFile(path.join(tmpDir, 'memory.json'), JSON.stringify(legacy), 'utf-8');
    // 我方 INSERT 判定前，并发方（另一实例）已插入赢家行
    sql.onInsertState = () => {
      sql.state.set('u1::', {
        data: memory([fact('f_winner', '赢家事实', vec(9))]),
      });
    };

    const loaded = await storage.load(scope);

    expect(loaded.facts.map((f) => f.content)).toEqual(['赢家事实']);
    // 旧文件向量未插入（行归赢家）
    expect(sql.vectors.has('u1::|fact|f_legacy')).toBe(false);
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
  });

  it('update 删除 fact 后向量表同步重建（DELETE + INSERT）', async () => {
    await storage.save(memory([fact('f1', 'a', vec(1)), fact('f2', 'b', vec(2))]), scope);

    await storage.update((current) => ({ ...current, facts: [current.facts[0]] }), scope);

    expect(sql.vectors.has('u1::|fact|f2')).toBe(false);
    expect(sql.vectors.has('u1::|fact|f1')).toBe(true);
    expect(sql.vectors.size).toBe(1);
  });

  it('update 在行不存在时事务内懒迁移，mutator 基于旧文件内容', async () => {
    const legacy = memory([fact('f_legacy', '旧文件事实', vec(7))]);
    await fs.writeFile(path.join(tmpDir, 'memory.json'), JSON.stringify(legacy), 'utf-8');

    const result = await storage.update(
      (current) => ({ ...current, facts: [...current.facts, fact('f2', '新事实', vec(2))] }),
      scope,
    );

    expect(result?.facts.map((f) => f.content)).toEqual(['旧文件事实', '新事实']);
    expect(sql.state.has('u1::')).toBe(true);
    expect(sql.vectors.has('u1::|fact|f_legacy')).toBe(true);
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
