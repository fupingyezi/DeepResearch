/**
 * 验证邮件 / 重置邮件的编排：令牌发放 + 邮件拼装（链接指向 app 域前端页面）。
 *
 * 发信是尽力而为：SMTP 未配置直接跳过、发送失败只告警不抛错——注册 / 找回的
 * 主流程不被邮件拖垮（未送达可重发，未验证状态前端也有入口重发）。
 */

import { isMailConfigured, sendMail } from '@/lib/mailer';

import { issueEmailToken } from './email-tokens';
import type { UserRecord } from './types';

/** 邮件链接的 app 域基址：APP_BASE_URL 优先，回落 CORS 白名单第一项。 */
function appBaseUrl(): string {
  const explicit = process.env.APP_BASE_URL?.trim();
  const source = explicit || process.env.CORS_ALLOWED_ORIGINS?.split(',')[0]?.trim();
  if (!source) {
    console.warn('[mailer] APP_BASE_URL 未配置，邮件链接将是相对路径，收件人无法点击');
    return '';
  }
  return source.replace(/\/+$/, '');
}

async function safeSend(opts: { to: string; subject: string; html: string }): Promise<void> {
  try {
    await sendMail(opts);
  } catch (error) {
    console.warn('[mailer] 发信失败（不影响主流程）:', (error as Error).message);
  }
}

export async function sendVerificationEmail(user: UserRecord): Promise<void> {
  if (!isMailConfigured()) return;
  const token = await issueEmailToken(user.id, 'verify_email');
  const link = `${appBaseUrl()}/verify-email?token=${token}`;
  await safeSend({
    to: user.email,
    subject: '验证你的邮箱 - mini-DeepResearch',
    html: `<p>你好，</p><p>请点击下面的链接完成邮箱验证（24 小时内有效）：</p><p><a href="${link}">${link}</a></p><p>如果这不是你的操作，请忽略此邮件。</p>`,
  });
}

export async function sendPasswordResetEmail(user: UserRecord): Promise<void> {
  if (!isMailConfigured()) return;
  const token = await issueEmailToken(user.id, 'reset_password');
  const link = `${appBaseUrl()}/reset-password?token=${token}`;
  await safeSend({
    to: user.email,
    subject: '重置密码 - mini-DeepResearch',
    html: `<p>请点击下面的链接重置密码（24 小时内有效）：</p><p><a href="${link}">${link}</a></p><p>如果这不是你的操作，请忽略此邮件。</p>`,
  });
}
