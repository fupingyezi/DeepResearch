/**
 * POST /api/auth/login —— 邮箱密码登录。
 *
 * 成功：签发 JWT 写入 HttpOnly cookie，返回 UserResponse。
 * 失败：401 INVALID_CREDENTIALS。
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  AuthErrorCode,
  authenticate,
  createAccessToken,
  toUserResponse,
} from '@deerflow-harness/auth';
import { jsonError, setSessionCookie } from '../_helpers';

interface LoginBody {
  email?: unknown;
  password?: unknown;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as LoginBody;
  const email = typeof body.email === 'string' ? body.email : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!email || !password) {
    return jsonError(AuthErrorCode.INVALID_INPUT, 'Email and password are required', 400);
  }

  const user = await authenticate(email, password);
  if (!user) {
    return jsonError(AuthErrorCode.INVALID_CREDENTIALS, 'Incorrect email or password', 401);
  }

  const token = createAccessToken(user.id, user.tokenVersion);
  const response = NextResponse.json(toUserResponse(user));
  setSessionCookie(response, token);
  return response;
}
