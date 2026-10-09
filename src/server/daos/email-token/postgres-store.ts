import { createHash, randomBytes } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';

import { query } from '@/lib/db';

import type { SqlExecutor } from '../shared';
import type { EmailTokenPurpose, EmailTokenStore } from './types';

const TOKEN_TTL_HOURS = 24;

export class PgEmailTokenStore implements EmailTokenStore {
  async issue(userId: string, purpose: EmailTokenPurpose, db?: SqlExecutor): Promise<string> {
    const raw = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(raw).digest('hex');
    const sql = `
      insert into email_tokens (id, user_id, purpose, token_hash, expires_at)
      values ($1, $2, $3, $4, now() + interval '${TOKEN_TTL_HOURS} hours');
    `;
    const params = [uuidv4(), userId, purpose, hash];
    if (db) await db.query(sql, params);
    else await query(sql, params);
    await query(`delete from email_tokens where user_id = $1 and expires_at < now();`, [userId]);
    return raw;
  }

  async consume(raw: string, purpose: EmailTokenPurpose): Promise<string | null> {
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
}
