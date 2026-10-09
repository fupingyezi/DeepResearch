/**
 * sessions 表的数据访问层（pg）：登录会话的创建与吊销。
 *
 * 会话是服务端可吊销的登录凭据载体：JWT 里带 sid，getCurrentUser 每次请求校验
 * 该 sid 未吊销且未过期——登出即时生效，不依赖 JWT 过期。
 * 创建时顺带清理该用户已过期/已吊销的旧会话行，表不随登录次数无界增长。
 */

import { v4 as uuidv4 } from 'uuid';

import { query } from '@/lib';

import { getTokenExpiryDays } from './jwt';

export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: string;
  revokedAt: string | null;
}

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

/** 会话过期时长与 JWT 一致（AUTH_TOKEN_EXPIRY_DAYS），两侧同步失效。 */
export async function createSession(userId: string): Promise<SessionRecord> {
  const id = uuidv4();
  const res = await query(
    `insert into sessions (id, user_id, expires_at)
     values ($1, $2, now() + make_interval(days => $3))
     returning id, user_id, expires_at, revoked_at;`,
    [id, userId, getTokenExpiryDays()],
  );
  await query(
    `delete from sessions where user_id = $1 and (expires_at < now() or revoked_at is not null);`,
    [userId],
  );
  return rowToSession(res.rows[0] as SessionRow);
}

export async function revokeSession(id: string): Promise<void> {
  await query(`update sessions set revoked_at = now() where id = $1 and revoked_at is null;`, [id]);
}

/** 会话有效 = 存在且未吊销且未过期。 */
export async function isSessionActive(id: string): Promise<boolean> {
  const res = await query(
    `select 1 from sessions where id = $1 and revoked_at is null and expires_at > now() limit 1;`,
    [id],
  );
  return res.rows.length > 0;
}
