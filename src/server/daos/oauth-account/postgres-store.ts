import { v4 as uuidv4 } from 'uuid';

import { query } from '@/lib/db';
import type { OAuthProviderName } from '@/lib/oauth';

import type { SqlExecutor } from '../shared';
import type { OAuthAccountRecord, OAuthAccountStore } from './types';

const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === PG_UNIQUE_VIOLATION;
}

interface OAuthAccountRow {
  id: string;
  user_id: string;
  provider: string;
  provider_user_id: string;
  created_at: string | Date;
}

function rowToRecord(row: OAuthAccountRow): OAuthAccountRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    provider: row.provider as OAuthProviderName,
    providerUserId: String(row.provider_user_id),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** 唯一冲突（(provider, provider_user_id) 已被绑定）时抛出 */
export class OAuthAccountExistsError extends Error {
  code = 'OAUTH_ACCOUNT_EXISTS';
  constructor() {
    super('OAuth account already bound');
  }
}

export class PgOAuthAccountStore implements OAuthAccountStore {
  async findByProvider(
    provider: OAuthProviderName,
    providerUserId: string,
  ): Promise<OAuthAccountRecord | null> {
    const res = await query(
      `select id, user_id, provider, provider_user_id, created_at
       from oauth_accounts where provider = $1 and provider_user_id = $2 limit 1;`,
      [provider, providerUserId],
    );
    return res.rows[0] ? rowToRecord(res.rows[0] as OAuthAccountRow) : null;
  }

  async create(
    userId: string,
    provider: OAuthProviderName,
    providerUserId: string,
    db?: SqlExecutor,
  ): Promise<OAuthAccountRecord> {
    const id = uuidv4();
    const sql = `
      insert into oauth_accounts (id, user_id, provider, provider_user_id)
      values ($1, $2, $3, $4)
      returning id, user_id, provider, provider_user_id, created_at;
    `;
    try {
      const res = db
        ? await db.query(sql, [id, userId, provider, providerUserId])
        : await query(sql, [id, userId, provider, providerUserId]);
      return rowToRecord(res.rows[0] as OAuthAccountRow);
    } catch (error) {
      if (isUniqueViolation(error)) throw new OAuthAccountExistsError();
      throw error;
    }
  }
}
