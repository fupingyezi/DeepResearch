/**
 * POST /api/auth/change-password —— 修改密码（可同时改邮箱）。
 *
 * 校验当前密码 → 更新 → 自增 token_version 使旧 token 失效 → 重新签发 cookie。
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  AuthErrorCode,
  changePassword,
  createAccessToken,
  validateStrongPassword,
} from '@deerflow-harness/auth';
import { getCurrentUser, jsonError, setSessionCookie } from '@/server/http';
import { parseJsonBody } from '@/server/validation';
import { changePasswordSchema } from '@/server/validation/schemas';

export async function POST(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return jsonError(AuthErrorCode.UNAUTHENTICATED, 'Not authenticated', 401);
  }

  const parsed = await parseJsonBody(request, changePasswordSchema);
  if (!parsed.ok) return parsed.response;

  const {
    current_password: currentPassword,
    new_password: newPassword,
    new_email: newEmail,
  } = parsed.data;

  const weak = validateStrongPassword(newPassword);
  if (weak) {
    return jsonError(AuthErrorCode.WEAK_PASSWORD, weak, 400);
  }

  const result = await changePassword(user.id, currentPassword, newPassword, newEmail);
  if (!result.ok || !result.user) {
    if (result.reason === 'email_taken') {
      return jsonError(AuthErrorCode.EMAIL_ALREADY_EXISTS, 'Email already in use', 400);
    }
    return jsonError(AuthErrorCode.INVALID_CREDENTIALS, 'Current password is incorrect', 400);
  }

  const token = createAccessToken(result.user.id, result.user.tokenVersion);
  const response = NextResponse.json({ message: 'Password changed successfully' });
  setSessionCookie(response, token);
  return response;
}
