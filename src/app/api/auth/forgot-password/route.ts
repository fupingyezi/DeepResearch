/**
 * POST /api/auth/forgot-password —— 忘记密码：向注册邮箱发重置邮件。
 *
 * 防用户枚举：无论邮箱是否注册都返回同一句话（真实用户才发信）；
 * SMTP 未配置时 503（发不出信的提示不能泄露账号存在性）。
 */

import { NextResponse } from 'next/server';

import { isMailConfigured } from '@/lib/mailer';
import { jsonError, withApiHandler } from '@/server/http';
import { createRateLimiter } from '@/server/http/rate-limit';
import { getAuthService } from '@/server/services/auth-service';
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
    await getAuthService().forgotPassword(body.email);
    return NextResponse.json({ message: '如果该邮箱已注册，重置邮件已发送' });
  },
);
