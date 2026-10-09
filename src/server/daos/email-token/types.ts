/**
 * email_tokens 表的领域类型与访问契约（邮箱验证 / 重置密码共用）。
 *
 * 安全模型：明文令牌只在发放时返回一次（拼进邮件链接），库中只存 sha256 哈希——
 * 库泄露不泄露可用令牌；核销单次有效且 24h 过期。
 */

import type { SqlExecutor } from '../shared';

export type EmailTokenPurpose = 'verify_email' | 'reset_password';

export interface EmailTokenStore {
  /** 发放令牌（返回明文）；同用户过期旧令牌顺带清理 */
  issue(userId: string, purpose: EmailTokenPurpose, db?: SqlExecutor): Promise<string>;
  /** 核销令牌：命中且未用且未过期才返回 userId；否则 null（令牌不可重放） */
  consume(raw: string, purpose: EmailTokenPurpose): Promise<string | null>;
}
