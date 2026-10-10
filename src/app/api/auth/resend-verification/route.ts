/**
 * POST /api/auth/resend-verification —— 重发验证邮件（登录态）。
 *
 * 已验证用户直接 200（幂等）；SMTP 未配置时 503——此时注册即已验证，正常走不到这里。
 */

import { NextResponse } from 'next/server';

import { isMailConfigured } from '@/lib/mailer';
import { jsonError, withApiHandler } from '@/server/http';
import { createRateLimiter } from '@/server/http/rate-limit';
import { getAuthService } from '@/server/services/auth-service';

export { OPTIONS } from '@/server/http/preflight';

const resendRateLimit = createRateLimiter({
  bucket: 'resendVerify',
  max: 5,
  windowMs: 15 * 60_000,
});

export const POST = withApiHandler({ rateLimit: resendRateLimit }, async ({ user }) => {
  if (user!.emailVerified) {
    return NextResponse.json({ message: 'Email already verified' });
  }
  if (!isMailConfigured()) {
    return jsonError('MAIL_NOT_CONFIGURED', 'Email service is not configured', 503);
  }
  await getAuthService().sendVerificationEmail(user!);
  return NextResponse.json({ message: 'Verification email sent' });
});
