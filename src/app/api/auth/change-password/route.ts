/**
 * POST /api/auth/change-password —— 修改密码（可同时改邮箱）。
 *
 * 校验当前密码 → 更新 → 自增 token_version 使旧 token 失效 → 重新签发 cookie。
 */

import { NextResponse } from 'next/server';

import { AuthErrorCode, changePassword, validateStrongPassword } from '@deerflow-harness/auth';
import { jsonError, setSessionCookie, withApiHandler } from '@/server/http';
import { createRateLimiter } from '@/server/http/rate-limit';
import { getAuthService } from '@/server/services/auth-service';
import { changePasswordSchema } from '@/server/validation/schemas';

export { OPTIONS } from '@/server/http/preflight';

const changePasswordRateLimit = createRateLimiter({
  bucket: 'changePassword',
  max: 10,
  windowMs: 15 * 60_000,
});

export const POST = withApiHandler(
  { body: changePasswordSchema, rateLimit: changePasswordRateLimit },
  async ({ user, body }) => {
    const {
      current_password: currentPassword,
      new_password: newPassword,
      new_email: newEmail,
    } = body;

    const weak = validateStrongPassword(newPassword);
    if (weak) {
      return jsonError(AuthErrorCode.WEAK_PASSWORD, weak, 400);
    }

    const result = await changePassword(user!.id, currentPassword, newPassword, newEmail);
    if (!result.ok || !result.user) {
      if (result.reason === 'email_taken') {
        return jsonError(AuthErrorCode.EMAIL_ALREADY_EXISTS, 'Email already in use', 400);
      }
      return jsonError(AuthErrorCode.INVALID_CREDENTIALS, 'Current password is incorrect', 400);
    }

    // 改密自增 tokenVersion 已使旧 token 全失效；新 token 挂新会话
    const token = await getAuthService().issueSessionToken(result.user);
    const response = NextResponse.json({ message: 'Password changed successfully' });
    setSessionCookie(response, token);
    return response;
  },
);
