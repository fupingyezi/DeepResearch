/**
 * POST /api/auth/forgot-password —— 忘记密码：向注册邮箱发重置邮件。
 *
 * 防用户枚举：无论邮箱是否注册都返回同一句话（真实用户才发信）；
 * SMTP 未配置时 503（发不出信的提示不能泄露账号存在性）。
 */

import { NextResponse } from 'next/server';

import { sendPasswordResetEmail } from '@deerflow-harness/auth/email-flow';
import { getUserByEmail } from '@deerflow-harness/auth/user-repository';
import { isMailConfigured } from '@/lib/mailer';
import { jsonError, withApiHandler } from '@/server/http';
import { createRateLimiter } from '@/server/http/rate-limit';
import { forgotPasswordSchema } from '@/server/validation/schemas';

export { OPTIONS } from '@/server/http/preflight';

const forgotRateLimit = createRateLimiter({
  bucket: 'forgotPassword',
  max: 5,
  windowMs: 15 * 60_000,
});

export const POST = withApiHandler(
  { auth: 'none', body: forgotPasswordSchema, rateLimit: forgotRateLimit },
  async ({ body }) => {
    if (!isMailConfigured()) {
      return jsonError('MAIL_NOT_CONFIGURED', 'Email service is not configured', 503);
    }
    const user = await getUserByEmail(body.email.trim().toLowerCase());
    if (user) {
      await sendPasswordResetEmail(user);
    }
    return NextResponse.json({ message: '如果该邮箱已注册，重置邮件已发送' });
  },
);
