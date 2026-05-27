/**
 * PgThreadMetaStore
 *
 * 安全：所有写入都走 `query(text, $1..$n)` 参数化 SQL；jsonb 字段通过
 * `::jsonb` 显式 cast；列名硬编码白名单，绝不拼字符串。
 */

import { query } from '@/lib/db';
import type {
  ThreadMeta,
  ThreadMetaCreateInput,
  ThreadMetaSearchOptions,
  ThreadMetaStore,
  ThreadStatus,
} from './types';

const ALLOWED_STATUS = new Set<ThreadStatus>(['idle', 'running', 'error', 'interrupted']);

interface ThreadMetaRow {
  thread_id: string;
  assistant_id: string;
  user_id: string | null;
  display_name: string;
  status: ThreadStatus;
  metadata: any;
  created_at: Date | string;
  updated_at: Date | string;
}

const toIso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

const rowToMeta = (r: ThreadMetaRow): ThreadMeta => ({
  thread_id: r.thread_id,
  assistant_id: r.assistant_id,
  user_id: r.user_id,
  display_name: r.display_name,
  status: r.status,
  metadata: (r.metadata && typeof r.metadata === 'object' ? (r.metadata as Record<string, any>) : {}),
  created_at: toIso(r.created_at),
  updated_at: toIso(r.updated_at),
});

export class PgThreadMetaStore implements ThreadMetaStore {
  async create(input: ThreadMetaCreateInput): Promise<ThreadMeta> {
    const sql = `
      insert into threads_meta
        (thread_id, assistant_id, user_id, display_name, status, metadata, created_at, updated_at)
      values ($1, $2, $3, $4, 'idle', $5::jsonb, now(), now())
      returning *;
    `;
    const params = [
      input.thread_id,
      input.assistant_id ?? 'lead',
      input.user_id ?? null,
      input.display_name ?? 'New thread',
      JSON.stringify(input.metadata ?? {}),
    ];
    const res = await query(sql, params);
    return rowToMeta(res.rows[0] as ThreadMetaRow);
  }

  async get(thread_id: string, opts?: { user_id?: string | null }): Promise<ThreadMeta | null> {
    const userId = opts?.user_id ?? null;
    const sql = userId
      ? `select * from threads_meta where thread_id = $1 and (user_id = $2 or user_id is null)`
      : `select * from threads_meta where thread_id = $1`;
    const params = userId ? [thread_id, userId] : [thread_id];
    const res = await query(sql, params);
    return res.rows.length ? rowToMeta(res.rows[0] as ThreadMetaRow) : null;
  }

  async search(opts: ThreadMetaSearchOptions): Promise<ThreadMeta[]> {
    const where: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (opts.user_id != null) {
      where.push(`user_id = $${i++}`);
      params.push(opts.user_id);
    }
    if (opts.status) {
      if (!ALLOWED_STATUS.has(opts.status)) {
        throw new Error(`invalid status: ${opts.status}`);
      }
      where.push(`status = $${i++}`);
      params.push(opts.status);
    }
    if (opts.metadata && Object.keys(opts.metadata).length > 0) {
      where.push(`metadata @> $${i++}::jsonb`);
      params.push(JSON.stringify(opts.metadata));
    }

    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const offset = Math.max(0, opts.offset ?? 0);
    const limitIdx = i++;
    const offsetIdx = i++;
    params.push(limit, offset);

    const sql = `
      select * from threads_meta
      ${where.length ? 'where ' + where.join(' and ') : ''}
      order by updated_at desc
      limit $${limitIdx} offset $${offsetIdx}
    `;

    const res = await query(sql, params as any[]);
    return (res.rows as ThreadMetaRow[]).map(rowToMeta);
  }

  async updateDisplayName(
    thread_id: string,
    name: string,
    opts?: { user_id?: string | null },
  ): Promise<void> {
    await this.assertOwner(thread_id, opts?.user_id);
    await query(
      `update threads_meta set display_name = $1, updated_at = now() where thread_id = $2`,
      [name, thread_id],
    );
  }

  async updateStatus(
    thread_id: string,
    status: ThreadStatus,
    opts?: { user_id?: string | null },
  ): Promise<void> {
    if (!ALLOWED_STATUS.has(status)) {
      throw new Error(`invalid status: ${status}`);
    }
    await this.assertOwner(thread_id, opts?.user_id);
    await query(
      `update threads_meta set status = $1, updated_at = now() where thread_id = $2`,
      [status, thread_id],
    );
  }

  async updateMetadata(
    thread_id: string,
    patch: Record<string, any>,
    opts?: { user_id?: string | null },
  ): Promise<void> {
    await this.assertOwner(thread_id, opts?.user_id);
    // 利用 PG 的 jsonb 合并语义（||）：右侧覆盖左侧的同 key
    await query(
      `update threads_meta set metadata = metadata || $1::jsonb, updated_at = now() where thread_id = $2`,
      [JSON.stringify(patch ?? {}), thread_id],
    );
  }

  async checkAccess(
    thread_id: string,
    user_id: string | null | undefined,
    opts?: { require_existing?: boolean },
  ): Promise<boolean> {
    // user_id 为空：当前阶段直接放行
    if (user_id == null || user_id === '') return true;
    const row = await this.get(thread_id);
    if (!row) return !opts?.require_existing;
    if (row.user_id == null) return true; // 历史/匿名记录不限制
    return row.user_id === user_id;
  }

  async delete(thread_id: string, opts?: { user_id?: string | null }): Promise<void> {
    await this.assertOwner(thread_id, opts?.user_id);
    await query(`delete from threads_meta where thread_id = $1`, [thread_id]);
  }

  private async assertOwner(thread_id: string, user_id?: string | null): Promise<void> {
    if (user_id == null || user_id === '') return; // 放行
    const ok = await this.checkAccess(thread_id, user_id, { require_existing: true });
    if (!ok) {
      const err = new Error(`forbidden: ${thread_id}`);
      (err as Error & { code?: string }).code = 'FORBIDDEN';
      throw err;
    }
  }
}
