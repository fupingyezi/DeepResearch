/**
 * POST /api/auth/login —— 邮箱密码登录。
 *
 * 成功：签发 JWT 写入 HttpOnly cookie，返回 UserResponse。
 * 失败：401 INVALID_CREDENTIALS。
 */

import { NextResponse } from 'next/server';

import {
  AuthErrorCode,
  authenticate,
  createAccessToken,
  toUserResponse,
} from '@deerflow-harness/auth';
import { jsonError, setSessionCookie, withApiHandler } from '@/server/http';
import { credentialsSchema } from '@/server/validation/schemas';

export { OPTIONS } from '@/server/http/preflight';

export const POST = withApiHandler({ auth: 'none', body: credentialsSchema }, async ({ body }) => {
  const user = await authenticate(body.email, body.password);
  if (!user) {
    return jsonError(AuthErrorCode.INVALID_CREDENTIALS, 'Incorrect email or password', 401);
  }

  const token = createAccessToken(user.id, user.tokenVersion);
  const response = NextResponse.json(toUserResponse(user));
  setSessionCookie(response, token);
  return response;
});
