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
import { jsonError, setSessionCookie } from '@/server/http';
import { parseJsonBody } from '@/server/validation';
import { credentialsSchema } from '@/server/validation/schemas';

export async function POST(request: NextRequest) {
  const parsed = await parseJsonBody(request, credentialsSchema);
  if (!parsed.ok) return parsed.response;

  const user = await authenticate(parsed.data.email, parsed.data.password);
  if (!user) {
    return jsonError(AuthErrorCode.INVALID_CREDENTIALS, 'Incorrect email or password', 401);
  }

  const token = createAccessToken(user.id, user.tokenVersion);
  const response = NextResponse.json(toUserResponse(user));
  setSessionCookie(response, token);
  return response;
}
