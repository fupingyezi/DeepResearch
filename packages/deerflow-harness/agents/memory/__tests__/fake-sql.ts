/**
 * 测试共享的内存假 SQL 执行器：按 SQL 前缀路由到两张 Map 表
 * （memory_state / memory_vectors），transaction 快照回滚。
 * 不模拟真实 PG 的行锁串行化——并发语义由 pg-storage.integration.test.ts
 * 在真实 PG 上验证。
 */

import { cosineSimilarity } from '../embeddings';
import type { MemorySqlExecutor } from '../storage';

export class FakeSql implements MemorySqlExecutor {
  state = new Map<string, Record<string, unknown>>();
  vectors = new Map<string, number[]>(); // `${scope}|${kind}|${ref}`
  calls: string[] = [];
  /** 注入一次性失败。 */
  failNext: Error | null = null;

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

    // load 的单语句快照读：state + 该 scope 全部向量聚合（真实 PG 里是
    // jsonb_agg 标量子查询，这里拼出同构的 vectors 数组）
    if (t.startsWith('SELECT m.data')) {
      const scope = String(params[0]);
      const row = this.state.get(scope);
      if (!row) return { rows: [], rowCount: null };
      const vectors = [...this.vectors.entries()]
        .filter(([k]) => k.startsWith(`${scope}|`))
        .map(([k, v]) => {
          const [, kind, ref] = k.split('|');
          return { kind, ref_id: ref, embedding: JSON.stringify(v) };
        });
      return { rows: [{ data: row.data, vectors }], rowCount: 1 };
    }

    if (t.startsWith('INSERT INTO memory_state')) {
      const key = String(params[0]);
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
