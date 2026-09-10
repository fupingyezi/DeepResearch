/**
 * POST /api/auth/demo-login —— 体验账号一键登录。
 *
 * 凭证取自服务器环境变量（AUTH_DEMO_EMAIL / AUTH_DEMO_PASSWORD），不接收请求体，
 * 前端永远拿不到密码。未配置返回 404；凭证与库中账号不匹配返回 401
 * （多半是 env 与账号密码不同步，检查服务器 .env.production）。
 */

import { NextResponse } from 'next/server';

import {
  AuthErrorCode,
  authenticate,
  createAccessToken,
  getDemoAccount,
  toUserResponse,
} from '@deerflow-harness/auth';
import { jsonError, setSessionCookie } from '../_helpers';

export async function POST() {
  const demo = getDemoAccount();
  if (!demo) {
    return jsonError(AuthErrorCode.INVALID_INPUT, 'Demo login is not enabled', 404);
  }

  const user = await authenticate(demo.email, demo.password);
  if (!user) {
    return jsonError(
      AuthErrorCode.INVALID_CREDENTIALS,
      'Demo account credentials are invalid',
      401,
    );
  }

  const token = createAccessToken(user.id, user.tokenVersion);
  const response = NextResponse.json(toUserResponse(user));
  setSessionCookie(response, token);
  return response;
}
