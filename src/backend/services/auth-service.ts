/**
 * 认证编排服务（app 层）：无状态 token 对签发与邮箱令牌流的领域编排。
 *
 * 数据访问全部落在 @/backend/repositories（email-token / user），本服务只组合
 * 纯逻辑（jwt 签发 / provider / 密码校验）与仓库——SQL 不进 harness。
 *
 * 发信为尽力而为：SMTP 未配置直接跳过、发送失败只告警不抛错——注册/找回的
 * 主流程不被邮件拖垮（未送达可重发，未验证状态前端也有入口重发）。
 */

import {
  createAccessToken,
  createRefreshToken,
  resetPassword as resetUserPassword,
  type TokenPair,
  type UserRecord,
} from '@/backend/auth';
import { getUserByEmail, updateUser } from '@/backend/repositories/user';
import { appBaseUrl } from '@/backend/lib/app-origin';
import { isMailConfigured, sendMail } from '@/backend/lib/mailer';
import {
  PgEmailTokenRepository,
  type EmailTokenRepository,
} from '@/backend/repositories/email-token';

export interface AuthServiceDeps {
  emailTokenStore: EmailTokenRepository;
}

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  /** 签发无状态 token 对（access 短 / refresh 长，均带 ver；无服务端会话） */
  issueTokenPair(user: UserRecord): TokenPair {
    return {
      accessToken: createAccessToken(user.id, user.tokenVersion),
      refreshToken: createRefreshToken(user.id, user.tokenVersion),
    };
  }

  /** 核销验证令牌并置 email_verified；无效/过期返回 false */
  async verifyEmail(token: string): Promise<boolean> {
    const userId = await this.deps.emailTokenStore.consume(token, 'verify_email');
    if (!userId) return false;
    await updateUser(userId, { emailVerified: true });
    return true;
  }

  async sendVerificationEmail(user: UserRecord): Promise<void> {
    if (!isMailConfigured()) return;
    const token = await this.deps.emailTokenStore.issue(user.id, 'verify_email');
    const link = `${appBaseUrl()}/verify-email?token=${token}`;
    await this.safeSend({
      to: user.email,
      subject: '验证你的邮箱 - DeepResearch',
      html: `<p>你好，</p><p>请点击下面的链接完成邮箱验证（24 小时内有效）：</p><p><a href="${link}">${link}</a></p><p>如果这不是你的操作，请忽略此邮件。</p>`,
    });
  }

  /** 忘记密码：真实用户才发信（防枚举由路由层恒定响应保证） */
  sendPasswordResetEmail(user: UserRecord): Promise<void> {
    return this.sendResetForEmail(user.email);
  }

  forgotPassword(email: string): Promise<void> {
    return this.sendResetForEmail(email);
  }

  /** 核销重置令牌并换哈希（tokenVersion+1 全端下线）；无效/过期返回 false */
  async resetPassword(token: string, newPassword: string): Promise<boolean> {
    const userId = await this.deps.emailTokenStore.consume(token, 'reset_password');
    if (!userId) return false;
    await resetUserPassword(userId, newPassword);
    return true;
  }

  /** 发信尽力而为：SMTP 未配置走 isMailConfigured 跳过，发送失败只告警不抛错 */
  private async safeSend(opts: { to: string; subject: string; html: string }): Promise<void> {
    try {
      await sendMail(opts);
    } catch (error) {
      console.warn('[mailer] 发信失败（不影响主流程）:', (error as Error).message);
    }
  }

  private async sendResetForEmail(email: string): Promise<void> {
    const user = await getUserByEmail(email.trim().toLowerCase());
    if (!user) return;
    const token = await this.deps.emailTokenStore.issue(user.id, 'reset_password');
    const link = `${appBaseUrl()}/reset-password?token=${token}`;
    await this.safeSend({
      to: user.email,
      subject: '重置密码 - DeepResearch',
      html: `<p>请点击下面的链接重置密码（24 小时内有效）：</p><p><a href="${link}">${link}</a></p><p>如果这不是你的操作，请忽略此邮件。</p>`,
    });
  }
}

export function createAuthService(deps?: Partial<AuthServiceDeps>): AuthService {
  return new AuthService({
    emailTokenStore: deps?.emailTokenStore ?? new PgEmailTokenRepository(),
  });
}

// 模块级懒单例即可：本服务无状态，不需要 globalThis 防 HMR 分裂（与
// file-service 同一约定）。
let service: AuthService | null = null;

export function getAuthService(): AuthService {
  if (!service) service = createAuthService();
  return service;
}
