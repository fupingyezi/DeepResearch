/**
 * POST /api/auth/reset-password —— 用邮件令牌重置密码。
 *
 * 令牌核销成功才重置（单次使用，暴力猜测每次尝试都会消耗令牌本身）；
 * resetPassword 自增 tokenVersion，该用户全部既有 JWT 失效。
 */

import { NextResponse } from 'next/server';

import { AuthErrorCode, resetPassword, validateStrongPassword } from '@deerflow-harness/auth';
import { consumeEmailToken } from '@deerflow-harness/auth/email-tokens';
import { jsonError, withApiHandler } from '@/server/http';
import { resetPasswordSchema } from '@/server/validation/schemas';

export { OPTIONS } from '@/server/http/preflight';

export const POST = withApiHandler(
  { auth: 'none', body: resetPasswordSchema },
  async ({ body }) => {
    const weak = validateStrongPassword(body.new_password);
    if (weak) {
      return jsonError(AuthErrorCode.WEAK_PASSWORD, weak, 400);
    }

    const userId = await consumeEmailToken(body.token, 'reset_password');
    if (!userId) {
      return jsonError('INVALID_TOKEN', 'Invalid or expired token', 400);
    }

    await resetPassword(userId, body.new_password);
    return NextResponse.json({ message: 'Password reset successfully' });
  },
);
