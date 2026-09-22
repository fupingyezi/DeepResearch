import { v4 as uuidv4 } from 'uuid';

import { query } from '@/lib/db';
import type { MessagePart } from '@/types';

import type { SqlExecutor } from '../shared';
import type {
  ChatMessageRow,
  ChatMessageStore,
  InsertChatMessageInput,
  LatestAssistantParts,
  LatestMessageRow,
} from './types';

type Row = Record<string, unknown>;

export class PgChatMessageStore implements ChatMessageStore {
  async insert(input: InsertChatMessageInput, db?: SqlExecutor): Promise<{ messageId: string }> {
    const messageId = input.messageId && input.messageId.length > 0 ? input.messageId : uuidv4();
    const partsJson = JSON.stringify(input.parts ?? []);
    const sql = `insert into chat_message (id, session_id, user_id, role, parts)
     values ($1, $2, $3, $4, $5::jsonb);`;
    const params: unknown[] = [messageId, input.sessionId, input.userId, input.role, partsJson];
    if (db) await db.query(sql, params);
    else await query(sql, params);
    return { messageId };
  }

  async updateParts(messageId: string, parts: MessagePart[]): Promise<void> {
    const partsJson = JSON.stringify(parts ?? []);
    await query(`update chat_message set parts = $2::jsonb where id = $1 and role = 'assistant';`, [
      messageId,
      partsJson,
    ]);
  }

  async deleteAtOrAfter(sessionId: string, fromCreatedAt: string | Date): Promise<void> {
    const isoTime =
      fromCreatedAt instanceof Date
        ? fromCreatedAt.toISOString()
        : new Date(fromCreatedAt).toISOString();
    await query(`delete from chat_message where session_id = $1 and created_at >= $2;`, [
      sessionId,
      isoTime,
    ]);
  }

  async getLatestByRole(
    sessionId: string,
    role: 'user' | 'assistant',
  ): Promise<LatestMessageRow | null> {
    const res = await query(
      `select id, role, created_at from chat_message
        where session_id = $1 and role = $2
        order by created_at desc
        limit 1;`,
      [sessionId, role],
    );
    const row = res.rows[0] as Row | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      role: row.role as 'user' | 'assistant',
      createdAt: new Date(row.created_at as string | number | Date),
    };
  }

  async getLatestAssistantWithParts(
    sessionId: string,
    userId: string,
  ): Promise<LatestAssistantParts | null> {
    const res = await query(
      `select id, parts from chat_message
        where session_id = $1 and user_id = $2 and role = 'assistant'
        order by created_at desc
        limit 1;`,
      [sessionId, userId],
    );
    const row = res.rows[0] as Row | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      parts: (row.parts ?? []) as MessagePart[],
    };
  }

  async listBySession(sessionId: string): Promise<ChatMessageRow[]> {
    const res = await query(
      `select id, session_id, role, parts, created_at from chat_message
        where session_id = $1
        order by created_at asc;`,
      [sessionId],
    );
    return res.rows.map((row: Row) => ({
      id: String(row.id),
      session_id: String(row.session_id),
      role: row.role as 'user' | 'assistant',
      parts: (row.parts ?? []) as MessagePart[],
      created_at: new Date(row.created_at as string | number | Date),
    }));
  }

  async deleteBySession(sessionId: string, userId: string, db?: SqlExecutor): Promise<void> {
    const sql = `delete from chat_message where session_id = $1 and user_id = $2`;
    const params: unknown[] = [sessionId, userId];
    if (db) await db.query(sql, params);
    else await query(sql, params);
  }
}
