/**
 * 认证编排服务（app 层）：会话与邮箱令牌流的领域编排。
 *
 * 数据访问全部落在 @/server/daos（session / email-token），本服务只组合
 * harness 的纯逻辑（jwt 签发 / provider / 密码校验）与 DAO——SQL 不进 harness。
 *
 * 发信为尽力而为：SMTP 未配置直接跳过、发送失败只告警不抛错——注册/找回的
 * 主流程不被邮件拖垮（未送达可重发，未验证状态前端也有入口重发）。
 */

import {
  createAccessToken,
  decodeTokenUnverified,
  getTokenExpiryDays,
  resetPassword as resetUserPassword,
  type UserRecord,
} from '@deerflow-harness/auth';
import { getUserByEmail, updateUser } from '@deerflow-harness/auth/user-repository';
import { isMailConfigured, sendMail } from '@/lib/mailer';
import { PgEmailTokenStore, type EmailTokenStore } from '@/server/daos/email-token';
import { PgSessionStore, type SessionStore } from '@/server/daos/session';

export interface AuthServiceDeps {
  sessionStore?: SessionStore;
  emailTokenStore?: EmailTokenStore;
}

export interface AuthService {
  /** 建会话并签发带 sid 的 JWT（登录/注册/改密等签发点的统一入口） */
  issueSessionToken(user: UserRecord): Promise<string>;
  /** logout：不验签解析 token 取 sid 吊销（token 可能已过期，吊销幂等） */
  revokeSessionForToken(token: string): Promise<void>;
  /** 会话有效性（getCurrentUser 每次请求校验） */
  isSessionActive(sid: string): Promise<boolean>;
  /** 核销验证令牌并置 email_verified；无效/过期返回 false */
  verifyEmail(token: string): Promise<boolean>;
  sendVerificationEmail(user: UserRecord): Promise<void>;
  /** 忘记密码：真实用户才发信（防枚举由路由层恒定响应保证） */
  sendPasswordResetEmail(user: UserRecord): Promise<void>;
  forgotPassword(email: string): Promise<void>;
  /** 核销重置令牌并换哈希（tokenVersion+1 全端下线）；无效/过期返回 false */
  resetPassword(token: string, newPassword: string): Promise<boolean>;
}

export function createAuthService(deps: AuthServiceDeps = {}): AuthService {
  const sessions = deps.sessionStore ?? new PgSessionStore();
  const emailTokens = deps.emailTokenStore ?? new PgEmailTokenStore();

  /** 邮件链接的 app 域基址：APP_BASE_URL 优先，回落 CORS 白名单第一项。 */
  const appBaseUrl = (): string => {
    const explicit = process.env.APP_BASE_URL?.trim();
    const source = explicit || process.env.CORS_ALLOWED_ORIGINS?.split(',')[0]?.trim();
    if (!source) {
      console.warn('[mailer] APP_BASE_URL 未配置，邮件链接将是相对路径，收件人无法点击');
      return '';
    }
    return source.replace(/\/+$/, '');
  };

  const safeSend = async (opts: { to: string; subject: string; html: string }): Promise<void> => {
    try {
      await sendMail(opts);
    } catch (error) {
      console.warn('[mailer] 发信失败（不影响主流程）:', (error as Error).message);
    }
  };

  const sendResetForEmail = async (email: string): Promise<void> => {
    const user = await getUserByEmail(email.trim().toLowerCase());
    if (!user) return;
    const token = await emailTokens.issue(user.id, 'reset_password');
    const link = `${appBaseUrl()}/reset-password?token=${token}`;
    await safeSend({
      to: user.email,
      subject: '重置密码 - mini-DeepResearch',
      html: `<p>请点击下面的链接重置密码（24 小时内有效）：</p><p><a href="${link}">${link}</a></p><p>如果这不是你的操作，请忽略此邮件。</p>`,
    });
  };

  return {
    async issueSessionToken(user) {
      const session = await sessions.create(user.id, getTokenExpiryDays());
      return createAccessToken(user.id, user.tokenVersion, session.id);
    },

    async revokeSessionForToken(token) {
      const payload = decodeTokenUnverified(token);
      if (payload) await sessions.revoke(payload.sid);
    },

    isSessionActive(sid) {
      return sessions.isActive(sid);
    },

    async verifyEmail(token) {
      const userId = await emailTokens.consume(token, 'verify_email');
      if (!userId) return false;
      await updateUser(userId, { emailVerified: true });
      return true;
    },

    async sendVerificationEmail(user) {
      if (!isMailConfigured()) return;
      const token = await emailTokens.issue(user.id, 'verify_email');
      const link = `${appBaseUrl()}/verify-email?token=${token}`;
      await safeSend({
        to: user.email,
        subject: '验证你的邮箱 - mini-DeepResearch',
        html: `<p>你好，</p><p>请点击下面的链接完成邮箱验证（24 小时内有效）：</p><p><a href="${link}">${link}</a></p><p>如果这不是你的操作，请忽略此邮件。</p>`,
      });
    },

    sendPasswordResetEmail(user) {
      return sendResetForEmail(user.email);
    },

    forgotPassword(email) {
      return sendResetForEmail(email);
    },

    async resetPassword(token, newPassword) {
      const userId = await emailTokens.consume(token, 'reset_password');
      if (!userId) return false;
      await resetUserPassword(userId, newPassword);
      return true;
    },
  };
}

let _authService: AuthService | null = null;

export function getAuthService(): AuthService {
  if (!_authService) _authService = createAuthService();
  return _authService;
}
