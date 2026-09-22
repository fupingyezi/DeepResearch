import { v4 as uuidv4 } from 'uuid';

import { query } from '@/lib/db';
import { toIso } from '@/utils/common';

import type { SqlExecutor } from '../shared';
import type {
  ChatSessionRecord,
  ChatSessionStore,
  ChatSessionWireRow,
  CreateChatSessionInput,
} from './types';
import { ChatSessionAccessError } from './types';

type Row = Record<string, unknown>;

function rowToSessionRecord(row: Row): ChatSessionRecord {
  return {
    id: String(row.id),
    seq_id: Number(row.seq_id),
    title: String(row.title),
    created_at: new Date(row.created_at as string | number | Date).getTime(),
    updated_at: new Date(row.updated_at as string | number | Date).getTime(),
  };
}

const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === PG_UNIQUE_VIOLATION;
}

export class PgChatSessionStore implements ChatSessionStore {
  async create(input: CreateChatSessionInput, db?: SqlExecutor): Promise<ChatSessionRecord> {
    const id = input.id && input.id.length > 0 ? input.id : uuidv4();
    const title = input.title && input.title.length > 0 ? input.title : 'New thread';
    const seq_id =
      typeof input.seq_id === 'number' ? input.seq_id : await this.nextSeqId(input.userId);
    const nowIso = new Date().toISOString();
    const createdAtIso = toIso(input.created_at) || nowIso;
    const updatedAtIso = toIso(input.updated_at) || nowIso;

    const sql = `
      insert into chat_session (id, seq_id, title, user_id, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6)
      returning *;
    `;
    const params: unknown[] = [id, seq_id, title, input.userId, createdAtIso, updatedAtIso];
    const res = db ? await db.query(sql, params) : await query(sql, params);

    return rowToSessionRecord(res.rows[0] as Row);
  }

  async getOwned(sessionId: string, userId: string): Promise<ChatSessionRecord | null> {
    const res = await query(`select * from chat_session where id = $1 limit 1;`, [sessionId]);
    const row = res.rows[0] as Row | undefined;
    if (!row) return null;
    if (row.user_id != null && String(row.user_id) !== userId) {
      throw new ChatSessionAccessError(`chat session ${sessionId} belongs to another user`);
    }
    return rowToSessionRecord(row);
  }

  async ensureOwned(input: CreateChatSessionInput): Promise<ChatSessionRecord> {
    if (input.id && input.id.length > 0) {
      const existing = await this.getOwned(input.id, input.userId);
      if (existing) return existing;
    }

    try {
      return await this.create(input);
    } catch (error) {
      // 并发重试撞主键：回读一次按归属返回，避免把可自愈的竞争报成 500
      if (input.id && isUniqueViolation(error)) {
        const existing = await this.getOwned(input.id, input.userId);
        if (existing) return existing;
      }
      throw error;
    }
  }

  async nextSeqId(userId: string): Promise<number> {
    const res = await query(
      `select coalesce(max(seq_id), 0) + 1 as next_seq_id from chat_session where user_id = $1;`,
      [userId],
    );
    const v = res.rows[0]?.next_seq_id;
    return typeof v === 'number' ? v : Number(v ?? 1);
  }

  async listByUser(userId: string): Promise<ChatSessionWireRow[]> {
    const res = await query(
      'select * from chat_session where user_id = $1 order by updated_at desc',
      [userId],
    );
    // 原样透传 pg 行（Date 保持 Date），不重映射 —— wire 契约见 types.ts
    return res.rows as unknown as ChatSessionWireRow[];
  }

  async updateTitle(
    sessionId: string,
    userId: string,
    title: string,
  ): Promise<ChatSessionRecord | null> {
    const res = await query(
      `update chat_session
          set title = $1, updated_at = $2
        where id = $3 and user_id = $4
        returning *;`,
      [title, new Date().toISOString(), sessionId, userId],
    );
    return res.rows.length === 0 ? null : rowToSessionRecord(res.rows[0] as Row);
  }

  async isOwned(sessionId: string, userId: string): Promise<boolean> {
    const res = await query(`select 1 from chat_session where id = $1 and user_id = $2 limit 1;`, [
      sessionId,
      userId,
    ]);
    return res.rows.length > 0;
  }

  async deleteOwned(
    sessionId: string,
    userId: string,
    db?: SqlExecutor,
  ): Promise<ChatSessionRecord | null> {
    const sql = `delete from chat_session where id = $1 and user_id = $2 returning *;`;
    const params: unknown[] = [sessionId, userId];
    const res = db ? await db.query(sql, params) : await query(sql, params);
    return res.rows.length === 0 ? null : rowToSessionRecord(res.rows[0] as Row);
  }
}
