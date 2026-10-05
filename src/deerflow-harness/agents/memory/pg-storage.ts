/**
 * PgMemoryStorage —— 记忆的 PG 后端（jsonb 结构 + pgvector 向量列）。
 *
 * 关键设计：
 * - **真相源在 PG**：memory_state.data（jsonb，不含 embedding）+ memory_vectors
 *   （vector 列，kind='fact'|'section'，ref_id = fact id / `<group>.<slot>`）。
 * - **update = 单事务行锁 RMW**：SELECT ... FOR UPDATE → 水合向量 → mutator →
 *   剥离 embedding 写 jsonb → DELETE+INSERT 重建向量 → COMMIT。行锁的锁粒度与
 *   并发语义一致（per-scope 串行），且与
 *   数据同生命周期（进程崩溃锁自动随事务消失）。
 * - **水合是硬约束**：mutator 之前必须把 vectors 塞回 current——updater 的
 *   embedMissingFacts/Sections 靠读 current 里的 embedding 判缺（updater.ts），
 *   jsonb 里没有 embedding，不水合则每轮更新都会全量重嵌。
 * - 无 mtime 缓存：单行 SELECT 亚毫秒，且缓存语义在跨进程下天然一致
 *   （进程内缓存需 mtime 失效，PG 不需要）。
 */

import { getMemoryConfig } from './config';
import {
  isCompatibleVector,
  isUnitVector,
  normalizeVector,
  RECALL_SECTION_SLOTS,
} from './embeddings';
import type { MemorySqlExecutor, MemoryStorage, VectorSearchResult } from './storage';
import {
  createEmptyMemory,
  Fact,
  MemoryData,
  mergeWithEmpty,
  SectionData,
  utcNowIsoZ,
} from './types';

interface Scope {
  key: string;
  agentName: string | null;
  userId: string | null;
}

/** 领域错误标记：mutator 抛出的错误要穿透 update 的事务层原样上抛（fact not found
 *  文案等语义在调用方），与 SQL/IO 失败（收敛为 null）区分。 */
class MutatorError extends Error {
  constructor(readonly origin: unknown) {
    super('memory mutator failed');
    this.name = 'MutatorError';
  }
}

const SELECT_STATE = `SELECT data FROM memory_state WHERE scope_key = $1`;

const UPSERT_STATE = `
  INSERT INTO memory_state (scope_key, user_id, agent_name, data, updated_at)
  VALUES ($1, $2, $3, $4::jsonb, now())
  ON CONFLICT (scope_key) DO UPDATE SET
    data = EXCLUDED.data,
    updated_at = EXCLUDED.updated_at,
    user_id = EXCLUDED.user_id,
    agent_name = EXCLUDED.agent_name`;

export class PgMemoryStorage implements MemoryStorage {
  constructor(private readonly sql: MemorySqlExecutor) {}

  private warnedLoadFailure = false;

  private toScope(opts: { agentName?: string | null; userId?: string | null }): Scope {
    const agentName = opts.agentName ?? null;
    const userId = opts.userId ?? null;
    return { key: `${userId ?? ''}::${agentName ?? ''}`, agentName, userId };
  }

  /** 把 jsonb / 文本形态的存储数据解析并合并到空 schema（防御旧数据缺字段）。 */
  private parseStoredData(raw: unknown): MemoryData {
    const parsed = typeof raw === 'string' ? (raw.trim() ? JSON.parse(raw) : null) : raw;
    if (!parsed || typeof parsed !== 'object') return createEmptyMemory();
    return mergeWithEmpty(parsed);
  }

  /**
   * 把 memory_vectors 的行塞回 data 结构（mutator 判缺的前提，见文件头注释）。
   * 解析失败（非法 JSON / 非有限数）的向量跳过，与 mergeSection 口径一致；
   * 维度不符的合法向量保留，由检索 / 回填按 config 维度判定失效并重算。
   */
  private async hydrateVectors(
    sql: MemorySqlExecutor,
    scopeKey: string,
    data: MemoryData,
  ): Promise<void> {
    const result = await sql.query(
      `SELECT kind, ref_id, embedding::text AS embedding
       FROM memory_vectors WHERE scope_key = $1`,
      [scopeKey],
    );
    const byFactId = new Map(data.facts.map((f) => [f.id, f]));
    for (const row of result.rows) {
      let vector: number[];
      try {
        const parsed: unknown = JSON.parse(String(row.embedding));
        if (
          !Array.isArray(parsed) ||
          !parsed.every((x) => typeof x === 'number' && Number.isFinite(x))
        ) {
          continue;
        }
        vector = parsed;
      } catch {
        continue;
      }
      if (row.kind === 'fact') {
        const fact = byFactId.get(String(row.ref_id));
        if (fact) fact.embedding = vector;
        continue;
      }
      // section：ref_id 形如 `user.topOfMind`（写入侧同口径生成）
      const ref = String(row.ref_id);
      const dot = ref.indexOf('.');
      if (dot <= 0) continue;
      const group = ref.slice(0, dot) as 'user' | 'history';
      const slot = ref.slice(dot + 1);
      if (group !== 'user' && group !== 'history') continue;
      const section = (data[group] as unknown as Record<string, SectionData>)[slot];
      if (section) section.embedding = vector;
    }
  }

  /** 从 data 收集可入库的向量行（维度合法才写；非单位向量先归一，保证
   *  `1 - <=>` 恒等于余弦）。 */
  private collectVectorRows(
    data: MemoryData,
  ): Array<{ kind: string; refId: string; vector: number[] }> {
    const dims = getEmbeddingDimensions();
    const rows: Array<{ kind: string; refId: string; vector: number[] }> = [];
    for (const f of data.facts) {
      if (isCompatibleVector(f.embedding, dims)) {
        rows.push({ kind: 'fact', refId: f.id, vector: toUnitVector(f.embedding) });
      }
    }
    for (const [group, slot] of RECALL_SECTION_SLOTS) {
      const section = (data[group] as unknown as Record<string, SectionData>)[slot];
      if (section?.summary && isCompatibleVector(section.embedding, dims)) {
        rows.push({
          kind: 'section',
          refId: `${group}.${slot}`,
          vector: toUnitVector(section.embedding!),
        });
      }
    }
    return rows;
  }

  /**
   * 写入向量行（始终 ON CONFLICT DO NOTHING）：update 重建前已 DELETE 同 scope
   * 全部行、冲突不可能发生；ON CONFLICT 只兜底极端并发下的主键残留。
   */
  private async insertVectors(
    sql: MemorySqlExecutor,
    scope: Scope,
    data: MemoryData,
  ): Promise<void> {
    const rows = this.collectVectorRows(data);
    if (rows.length === 0) return;
    const params: unknown[] = [];
    const values: string[] = [];
    for (const row of rows) {
      const base = params.length;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::vector)`);
      params.push(scope.key, row.kind, row.refId, JSON.stringify(row.vector));
    }
    await sql.query(
      `INSERT INTO memory_vectors (scope_key, kind, ref_id, embedding)
       VALUES ${values.join(', ')}
       ON CONFLICT DO NOTHING`,
      params,
    );
  }

  private async readData(opts: {
    agentName?: string | null;
    userId?: string | null;
  }): Promise<MemoryData> {
    const scope = this.toScope(opts);
    try {
      const result = await this.sql.query(SELECT_STATE, [scope.key]);
      if (result.rows.length === 0) return createEmptyMemory();
      const data = this.parseStoredData(result.rows[0].data);
      await this.hydrateVectors(this.sql, scope.key, data);
      return data;
    } catch (e) {
      // PG 故障回落空 schema（记忆功能不损，仅内容暂空）。
      // 只告警一次：中断期每轮聊天都走这里，逐次告警会刷屏。
      if (!this.warnedLoadFailure) {
        this.warnedLoadFailure = true;
        console.warn('[memory/pg-storage] load failed, returning empty memory:', e);
      }
      return createEmptyMemory();
    }
  }

  async load(
    opts: { agentName?: string | null; userId?: string | null } = {},
  ): Promise<MemoryData> {
    return this.readData(opts);
  }

  async reload(
    opts: { agentName?: string | null; userId?: string | null } = {},
  ): Promise<MemoryData> {
    // 无进程内缓存：load 与 reload 语义相同
    return this.readData(opts);
  }

  async save(
    data: MemoryData,
    opts: { agentName?: string | null; userId?: string | null } = {},
  ): Promise<boolean> {
    // 与 update 同一条事务路径：全量覆盖也是 RMW，不能绕过行锁直接写
    const updated = await this.update(() => data, opts);
    return updated !== null;
  }

  async update(
    mutator: (current: MemoryData) => Promise<MemoryData> | MemoryData,
    opts: { agentName?: string | null; userId?: string | null } = {},
  ): Promise<MemoryData | null> {
    const scope = this.toScope(opts);
    try {
      return await this.sql.transaction(async (tx) => {
        const current = await this.readLocked(tx, scope);

        // 先水合向量到 current（硬约束，见文件头注释），再交 mutator
        await this.hydrateVectors(tx, scope.key, current);

        let next: MemoryData;
        try {
          next = await mutator(current);
        } catch (e) {
          // 领域错误（fact not found 等）标记后穿透外层 catch 原样上抛；
          // 事务 wrapper 会回滚，不留下半截写
          throw new MutatorError(e);
        }
        if (next === current) return current;

        // shallow copy + 刷新 lastUpdated（避免直接 mutate 调用方对象）
        const toWrite: MemoryData = { ...next, lastUpdated: utcNowIsoZ() };
        await tx.query(UPSERT_STATE, [
          scope.key,
          scope.userId,
          scope.agentName,
          JSON.stringify(stripEmbeddings(toWrite)),
        ]);
        // 向量全量重建：比 diff 简单且条数受 maxFacts（100）约束；DELETE+INSERT
        // 在同一事务内，任何一步失败整体回滚，不出现「jsonb 新、向量旧」的中间态
        await tx.query(`DELETE FROM memory_vectors WHERE scope_key = $1`, [scope.key]);
        await this.insertVectors(tx, scope, toWrite);
        return toWrite;
      });
    } catch (e) {
      if (e instanceof MutatorError) throw e.origin;
      console.error('[memory/pg-storage] update failed:', e);
      return null;
    }
  }

  /** 行锁读：SELECT ... FOR UPDATE；行不存在（scope 尚无数据）返回空 schema，
   *  后续 UPSERT 会创建行。 */
  private async readLocked(tx: MemorySqlExecutor, scope: Scope): Promise<MemoryData> {
    const result = await tx.query(`${SELECT_STATE} FOR UPDATE`, [scope.key]);
    return result.rows.length > 0 ? this.parseStoredData(result.rows[0].data) : createEmptyMemory();
  }

  async vectorSearch(
    opts: { agentName?: string | null; userId?: string | null },
    queryVector: number[],
    limit: number,
  ): Promise<VectorSearchResult[]> {
    const scope = this.toScope(opts);
    // 存库向量已 L2 归一，<=>（余弦距离）与 `1 - 距离`（余弦相似度）互为补。
    // 失败原样上抛：调用方（检索）据此回落 JS 余弦扫描。
    const result = await this.sql.query(
      `SELECT kind, ref_id, 1 - (embedding <=> $1::vector) AS similarity
       FROM memory_vectors
       WHERE scope_key = $2
       ORDER BY embedding <=> $1::vector ASC
       LIMIT $3`,
      [JSON.stringify(queryVector), scope.key, limit],
    );
    return result.rows.map((row) => ({
      kind: row.kind as 'fact' | 'section',
      refId: String(row.ref_id),
      similarity: Number(row.similarity),
    }));
  }
}

function getEmbeddingDimensions(): number {
  return getMemoryConfig().embeddingDimensions;
}

/** 非单位向量先归一（importMemoryData 导入的原始向量等）。 */
function toUnitVector(v: number[]): number[] {
  return isUnitVector(v) ? v : normalizeVector(v);
}

/** 剥离 embedding 得 jsonb：向量只存 memory_vectors，jsonb 不冗余一份
 *  （100 条 × 1024 维浮点的 JSON 序列化是 MB 级）。 */
function stripEmbeddings(data: MemoryData): MemoryData {
  const stripSection = (s: SectionData): SectionData => {
    if (s.embedding == null) return s;
    const rest = { ...s };
    delete rest.embedding;
    return rest;
  };
  const stripFact = (f: Fact): Fact => {
    if (f.embedding == null) return f;
    const rest = { ...f };
    delete rest.embedding;
    return rest;
  };
  return {
    ...data,
    user: {
      workContext: stripSection(data.user.workContext),
      personalContext: stripSection(data.user.personalContext),
      topOfMind: stripSection(data.user.topOfMind),
    },
    history: {
      recentMonths: stripSection(data.history.recentMonths),
      earlierContext: stripSection(data.history.earlierContext),
      longTermBackground: stripSection(data.history.longTermBackground),
    },
    facts: data.facts.map(stripFact),
  };
}
