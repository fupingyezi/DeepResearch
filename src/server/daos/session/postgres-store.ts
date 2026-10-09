import { v4 as uuidv4 } from 'uuid';

import { query } from '@/lib/db';

import type { SqlExecutor } from '../shared';
import type { SessionRecord, SessionStore } from './types';

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string | Date;
  revoked_at: string | Date | null;
}

function rowToSession(row: SessionRow): SessionRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    expiresAt: new Date(row.expires_at).toISOString(),
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}

export class PgSessionStore implements SessionStore {
  async create(userId: string, ttlDays: number, db?: SqlExecutor): Promise<SessionRecord> {
    const id = uuidv4();
    const sql = `
      insert into sessions (id, user_id, expires_at)
      values ($1, $2, now() + make_interval(days => $3))
      returning id, user_id, expires_at, revoked_at;
    `;
    const res = db
      ? await db.query(sql, [id, userId, ttlDays])
      : await query(sql, [id, userId, ttlDays]);
    // 顺带清理该用户已过期/已吊销的旧会话行，表不随登录次数无界增长
    await query(
      `delete from sessions where user_id = $1 and (expires_at < now() or revoked_at is not null);`,
      [userId],
    );
    return rowToSession(res.rows[0] as SessionRow);
  }

  async revoke(id: string): Promise<void> {
    await query(`update sessions set revoked_at = now() where id = $1 and revoked_at is null;`, [
      id,
    ]);
  }

  async isActive(id: string): Promise<boolean> {
    const res = await query(
      `select 1 from sessions where id = $1 and revoked_at is null and expires_at > now() limit 1;`,
      [id],
    );
    return res.rows.length > 0;
  }
}
