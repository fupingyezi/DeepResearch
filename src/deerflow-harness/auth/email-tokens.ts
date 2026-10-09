/**
 * 邮箱令牌（邮箱验证 / 重置密码）的发放与核销。
 *
 * 安全模型：明文令牌只在发放时返回一次（拼进邮件链接），库中只存 sha256 哈希——
 * 库泄露不泄露可用令牌；核销单次有效（used_at 置位）且 24h 过期。
 * 发放时顺带清理同用户过期旧令牌，表不随发放次数无界增长。
 */

import { createHash, randomBytes } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';

import { query } from '@/lib';

export type EmailTokenPurpose = 'verify_email' | 'reset_password';

const TOKEN_TTL_HOURS = 24;

export async function issueEmailToken(userId: string, purpose: EmailTokenPurpose): Promise<string> {
  const raw = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(raw).digest('hex');
  await query(
    `insert into email_tokens (id, user_id, purpose, token_hash, expires_at)
     values ($1, $2, $3, $4, now() + interval '${TOKEN_TTL_HOURS} hours');`,
    [uuidv4(), userId, purpose, hash],
  );
  await query(`delete from email_tokens where user_id = $1 and expires_at < now();`, [userId]);
  return raw;
}

/** 核销令牌：命中且未用且未过期才返回 userId 并置 used_at；否则 null（令牌不可重放）。 */
export async function consumeEmailToken(
  raw: string,
  purpose: EmailTokenPurpose,
): Promise<string | null> {
  const hash = createHash('sha256').update(raw).digest('hex');
  const res = await query(
    `select id, user_id from email_tokens
     where token_hash = $1 and purpose = $2 and used_at is null and expires_at > now()
     limit 1;`,
    [hash, purpose],
  );
  const row = res.rows[0] as { id: string; user_id: string } | undefined;
  if (!row) return null;
  await query(`update email_tokens set used_at = now() where id = $1;`, [row.id]);
  return String(row.user_id);
}
