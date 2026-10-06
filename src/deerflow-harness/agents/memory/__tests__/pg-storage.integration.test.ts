import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { setMemoryConfig, DEFAULT_MEMORY_CONFIG } from '../config';
import { PgMemoryStorage } from '../pg-storage';
import type { MemorySqlExecutor } from '../storage';
import type { Fact, MemoryData, SectionData } from '../types';

/**
 * PgMemoryStorage 集成测试：真实 PG + pgvector 上的语义（`::vector` 参数绑定、
 * `embedding::text` 水合往返、`<=>` 余弦排序）。无 DATABASE_URL 时整套跳过，
 * 与 redis-dist-lock 集成套件同一约定。
 *
 * 用独立 scope_key（`it:<uuid>::`）与真实表，跑完清理；表的 DDL 与
 * lib/db 的 initialMemoryDb 一致（已存在则沿用实际列维度）。
 */

const DATABASE_URL = process.env.DATABASE_URL;

let hasPg = false;
let probePool: Pool | null = null;
/** 实际向量列维度：探测现有表；表不存在则按默认 1024 建表。 */
let DIMS = 1024;

if (DATABASE_URL) {
  try {
    probePool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2_000 });
    await probePool.query('SELECT 1');
    await probePool.query('CREATE EXTENSION IF NOT EXISTS vector');
    let currentDims: number | null = null;
    try {
      const r = await probePool.query(
        `SELECT atttypmod AS dims FROM pg_attribute
         WHERE attrelid = 'memory_vectors'::regclass AND attname = 'embedding'`,
      );
      currentDims = Number(r.rows[0]?.dims);
    } catch {
      // 表不存在：按 app 侧同款 DDL 建表
      await probePool.query(`
        CREATE TABLE IF NOT EXISTS memory_state (
          scope_key  varchar(255) primary key,
          user_id    varchar(128),
          agent_name varchar(64),
          data       jsonb not null,
          updated_at timestamptz not null default now()
        );
        CREATE TABLE IF NOT EXISTS memory_vectors (
          scope_key varchar(255) not null references memory_state(scope_key) on delete cascade,
          kind      varchar(8)  not null check (kind in ('fact','section')),
          ref_id    varchar(64) not null,
          embedding vector(1024) not null,
          primary key (scope_key, kind, ref_id)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_vectors_scope ON memory_vectors(scope_key);
      `);
    }
    if (currentDims != null && Number.isFinite(currentDims)) DIMS = currentDims;
    hasPg = true;
  } catch {
    hasPg = false;
  }
  await probePool?.end().catch(() => {});
}

/** 单位向量（第 dim 位为 1，其余 0；seed=dim 则指向该维）。 */
function unitVec(seed: number): number[] {
  return Array.from({ length: DIMS }, (_, i) => (i === seed ? 1 : 0));
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

describe.skipIf(!hasPg)('PgMemoryStorage · 真实 PG', () => {
  let pool: Pool;
  let executor: MemorySqlExecutor;
  let storage: PgMemoryStorage;
  let secondStorage: PgMemoryStorage;
  let userId: string;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    executor = {
      query: async (text, params) => {
        const r = await pool.query(text, (params ?? []) as any[]);
        return { rows: r.rows as Record<string, unknown>[], rowCount: r.rowCount };
      },
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const tx: MemorySqlExecutor = {
            query: async (t, p) => {
              const r = await client.query(t, (p ?? []) as any[]);
              return { rows: r.rows as Record<string, unknown>[], rowCount: r.rowCount };
            },
            transaction: async () => {
              throw new Error('nested transactions are not supported');
            },
          };
          const out = await fn(tx);
          await client.query('COMMIT');
          return out;
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          client.release();
        }
      },
    };
    storage = new PgMemoryStorage(executor);
    // 第二个实例共享同一连接池：模拟另一进程的读写视角
    secondStorage = new PgMemoryStorage(executor);
  });

  beforeEach(() => {
    userId = `it:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    setMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, embeddingDimensions: DIMS });
  });

  afterEach(async () => {
    setMemoryConfig({ ...DEFAULT_MEMORY_CONFIG });
    await pool
      .query('DELETE FROM memory_state WHERE scope_key = $1', [`${userId}::`])
      .catch(() => {});
  });

  afterAll(async () => {
    await pool.end().catch(() => {});
  });

  it('save + load 往返：embedding::text 水合还原向量（列维度 = 探测值）', async () => {
    const scope = { agentName: null, userId };
    const v = unitVec(3);
    const ok = await storage.save(
      memory([fact('f1', '往返事实', v)], { summary: '在学日语', embedding: unitVec(7) }),
      scope,
    );
    expect(ok).toBe(true);

    const loaded = await storage.load(scope);
    const emb = loaded.facts[0]?.embedding;
    expect(emb).toHaveLength(DIMS);
    expect(emb).toEqual(v); // 硬约束：漏掉 ::text + JSON.parse 会在这里显式失败
    expect(loaded.user.topOfMind.embedding).toEqual(unitVec(7));
  });

  it('vectorSearch：真实 <=> 余弦排序，1 - 距离 = 相似度', async () => {
    const scope = { agentName: null, userId };
    const q = unitVec(1);
    await storage.save(
      memory([fact('f_near', '同向', unitVec(1)), fact('f_orth', '正交', unitVec(2))]),
      scope,
    );

    const results = await storage.vectorSearch(scope, q, 2);

    expect(results).toHaveLength(2);
    expect(results[0].refId).toBe('f_near');
    expect(results[0].similarity).toBeCloseTo(1, 5);
    expect(results[1].refId).toBe('f_orth');
    expect(results[1].similarity).toBeCloseTo(0, 5);
  });

  it('update 事务：jsonb 不含 embedding、向量表重建、跨实例可见', async () => {
    const scope = { agentName: null, userId };
    await storage.save(memory([fact('f1', 'a', unitVec(1))]), scope);

    const result = await storage.update(
      (current) => ({ ...current, facts: [...current.facts, fact('f2', 'b', unitVec(2))] }),
      scope,
    );
    expect(result?.facts.map((f) => f.content)).toEqual(['a', 'b']);

    const raw = await pool.query('SELECT data FROM memory_state WHERE scope_key = $1', [
      `${userId}::`,
    ]);
    expect(JSON.stringify(raw.rows[0].data)).not.toContain('embedding');

    const viaOther = await secondStorage.load(scope);
    expect(viaOther.facts.map((f) => f.content)).toEqual(['a', 'b']);
    expect(viaOther.facts[1]?.embedding).toEqual(unitVec(2));
  });

  it('并发 update 串行化：两次 update 不丢写（行锁语义）', async () => {
    const scope = { agentName: null, userId };
    await storage.save(memory([fact('f1', 'a')]), scope);

    const add = (id: string) =>
      storage.update((current) => ({ ...current, facts: [...current.facts, fact(id, id)] }), scope);
    const [r1, r2] = await Promise.all([add('f2'), add('f3')]);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();

    const final = await storage.load(scope);
    expect(final.facts.map((f) => f.content).sort()).toEqual(['a', 'f2', 'f3']);
  });

  it('并发首写同一 scope 不丢更新（readLocked 先造行再 FOR UPDATE）', async () => {
    // 首写场景：scope 行不存在。FOR UPDATE 锁不住不存在的行，两个事务会同时
    // 读空、各自 UPSERT，后提交者覆盖先提交者——去掉「先造行」这一步，
    // 最终只会有其中一条 fact。
    const scope = { agentName: null, userId };
    const add = (id: string) =>
      storage.update((current) => ({ ...current, facts: [...current.facts, fact(id, id)] }), scope);
    const [r1, r2] = await Promise.all([add('f1'), add('f2')]);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();

    const final = await storage.load(scope);
    expect(final.facts.map((f) => f.content).sort()).toEqual(['f1', 'f2']);
  });
});
