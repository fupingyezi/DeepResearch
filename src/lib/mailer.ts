/**
 * SMTP 发信（nodemailer）：邮箱验证 / 找回密码邮件共用。
 *
 * 设计取舍：SMTP_* 未配置时 isMailConfigured()=false，调用方直接跳过发信
 * （注册时用户直接视为已验证）——发信功能缺失不阻断主体链路；
 * 配置了但发送失败只告警不抛错，未送达可重发。
 */

import nodemailer, { type Transporter } from 'nodemailer';

// dev 下 HMR 反复求值模块：transport 挂 globalThis 防每路重建连接
const globalForMailer = globalThis as unknown as { __mailerTransport?: Transporter | null };

export function isMailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_FROM);
}

function getTransport(): Transporter | null {
  if (!isMailConfigured()) return null;
  if (!globalForMailer.__mailerTransport) {
    const port = Number(process.env.SMTP_PORT ?? 587);
    globalForMailer.__mailerTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      // secure=true 走 465 隐式 TLS；587 由 nodemailer 自动 STARTTLS 协商
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD ?? '',
      },
    });
  }
  return globalForMailer.__mailerTransport;
}

export async function sendMail(opts: { to: string; subject: string; html: string }): Promise<void> {
  const transport = getTransport();
  if (!transport) {
    console.warn('[mailer] SMTP 未配置，跳过发信：', opts.subject);
    return;
  }
  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
  });
}
