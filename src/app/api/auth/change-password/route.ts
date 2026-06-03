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
import { getCurrentUser, jsonError, setSessionCookie } from '../_helpers';

interface ChangePasswordBody {
  current_password?: unknown;
  new_password?: unknown;
  new_email?: unknown;
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return jsonError(AuthErrorCode.UNAUTHENTICATED, 'Not authenticated', 401);
  }

  const body = (await request.json().catch(() => ({}))) as ChangePasswordBody;
  const currentPassword = typeof body.current_password === 'string' ? body.current_password : '';
  const newPassword = typeof body.new_password === 'string' ? body.new_password : '';
  const newEmail = typeof body.new_email === 'string' ? body.new_email : undefined;

  if (!currentPassword || !newPassword) {
    return jsonError(AuthErrorCode.INVALID_INPUT, 'Current and new password are required', 400);
  }

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
