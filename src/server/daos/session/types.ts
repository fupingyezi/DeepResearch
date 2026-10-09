/**
 * sessions 表的领域类型与访问契约。
 *
 * 会话是服务端可吊销的登录凭据载体：JWT 里带 sid，每次鉴权校验该 sid
 * 未吊销且未过期——登出即时生效，不依赖 JWT 过期。
 */

import type { SqlExecutor } from '../shared';

export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface SessionStore {
  /** 建会话；ttlDays 由调用方传入（dao 不读 env），过期与 JWT 同源对齐 */
  create(userId: string, ttlDays: number, db?: SqlExecutor): Promise<SessionRecord>;
  /** 吊销：已吊销的会话重复吊销是 no-op（幂等） */
  revoke(id: string): Promise<void>;
  /** 会话有效 = 存在且未吊销且未过期 */
  isActive(id: string): Promise<boolean>;
}
