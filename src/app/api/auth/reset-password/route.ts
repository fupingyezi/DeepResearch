/**
 * POST /api/auth/reset-password —— 用邮件令牌重置密码。
 *
 * 令牌核销成功才重置（单次使用，暴力猜测每次尝试都会消耗令牌本身）；
 * 重置自增 tokenVersion，该用户全部既有 JWT 失效。
 */

import { NextResponse } from 'next/server';

import { AuthErrorCode, validateStrongPassword } from '@deerflow-harness/auth';
import { jsonError, withApiHandler } from '@/server/http';
import { getAuthService } from '@/server/services/auth-service';
import { resetPasswordSchema } from '@/server/validation/schemas';

export { OPTIONS } from '@/server/http/preflight';

export const POST = withApiHandler(
  { auth: 'none', body: resetPasswordSchema },
  async ({ body }) => {
    const weak = validateStrongPassword(body.new_password);
    if (weak) {
      return jsonError(AuthErrorCode.WEAK_PASSWORD, weak, 400);
    }

    const reset = await getAuthService().resetPassword(body.token, body.new_password);
    if (!reset) {
      return jsonError('INVALID_TOKEN', 'Invalid or expired token', 400);
    }

    return NextResponse.json({ message: 'Password reset successfully' });
  },
);
