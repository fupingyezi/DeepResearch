/**
 * OAuth 账号绑定 DAO 契约（app 侧第五张表）。
 *
 * oauth_accounts 的读写只有本 DAO（DDL 在 lib/db 的 initialDB），
 * 唯一约束 (provider, provider_user_id) 保证同一平台账号只绑定一个用户。
 */
import type { OAuthProviderName } from '@/lib/oauth';

import type { SqlExecutor } from '../shared';

export interface OAuthAccountRecord {
  id: string;
  userId: string;
  provider: OAuthProviderName;
  providerUserId: string;
  createdAt: string;
}

export interface OAuthAccountStore {
  findByProvider(
    provider: OAuthProviderName,
    providerUserId: string,
  ): Promise<OAuthAccountRecord | null>;
  create(
    userId: string,
    provider: OAuthProviderName,
    providerUserId: string,
    db?: SqlExecutor,
  ): Promise<OAuthAccountRecord>;
}
