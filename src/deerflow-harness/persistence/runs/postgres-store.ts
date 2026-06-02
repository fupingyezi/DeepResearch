/**
 * PgRunStore —— Postgres 版 RunStore 实现
 */

import { query } from '@/lib/db';
import type { Run, RunCreateInput, RunListOptions, RunStatus, RunStore } from './types';
import { toIso } from '@/utils/common';

const ALLOWED_STATUS = new Set<RunStatus>([
  'pending',
  'running',
  'succeeded',
  'failed',
  'interrupted',
]);

interface RunRow {
  run_id: string;
  thread_id: string;
  assistant_id: string;
  user_id: string | null;
  status: RunStatus;
  input: any;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const rowToRun = (r: RunRow): Run => ({
  run_id: r.run_id,
  thread_id: r.thread_id,
  assistant_id: r.assistant_id,
  user_id: r.user_id,
  status: r.status,
  input: r.input,
  error: r.error,
  created_at: toIso(r.created_at),
  updated_at: toIso(r.updated_at),
});

export class PgRunStore implements RunStore {
  async create(input: RunCreateInput): Promise<Run> {
    const sql = `
      insert into runs
        (run_id, thread_id, assistant_id, user_id, status, input, created_at, updated_at)
      values ($1, $2, $3, $4, 'pending', $5::jsonb, now(), now())
      returning *;
    `;
    const params = [
      input.run_id,
      input.thread_id,
      input.assistant_id ?? 'lead',
      input.user_id ?? null,
      JSON.stringify(input.input ?? null),
    ];
    const res = await query(sql, params);
    return rowToRun(res.rows[0] as RunRow);
  }

  async setStatus(run_id: string, status: RunStatus, error?: string | null): Promise<void> {
    if (!ALLOWED_STATUS.has(status)) {
      throw new Error(`invalid run status: ${status}`);
    }
    await query(`update runs set status = $1, error = $2, updated_at = now() where run_id = $3`, [
      status,
      error ?? null,
      run_id,
    ]);
  }

  async get(run_id: string): Promise<Run | null> {
    const res = await query(`select * from runs where run_id = $1`, [run_id]);
    return res.rows.length ? rowToRun(res.rows[0] as RunRow) : null;
  }

  async listByThread(thread_id: string, opts?: RunListOptions): Promise<Run[]> {
    const where: string[] = ['thread_id = $1'];
    const params: any[] = [thread_id];
    let i = 2;

    if (opts?.status) {
      if (!ALLOWED_STATUS.has(opts.status)) {
        throw new Error(`invalid run status: ${opts.status}`);
      }
      where.push(`status = $${i++}`);
      params.push(opts.status);
    }

    const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200));
    const offset = Math.max(0, opts?.offset ?? 0);
    const limitIdx = i++;
    const offsetIdx = i++;
    params.push(limit, offset);

    const sql = `
      select * from runs
      where ${where.join(' and ')}
      order by created_at desc
      limit $${limitIdx} offset $${offsetIdx}
    `;
    const res = await query(sql, params);
    return (res.rows as RunRow[]).map(rowToRun);
  }
}
