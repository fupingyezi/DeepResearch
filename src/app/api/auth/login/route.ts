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
  createSession,
  toUserResponse,
} from '@deerflow-harness/auth';
import { jsonError, setSessionCookie, withApiHandler } from '@/server/http';
import { createRateLimiter, loginFailures } from '@/server/http/rate-limit';
import { credentialsSchema } from '@/server/validation/schemas';

export { OPTIONS } from '@/server/http/preflight';

// IP 维度兜底防爆破；账号维度失败锁定见 loginFailures（handler 内先判锁再验密码，
// 锁定期内不消耗 bcrypt）
const loginRateLimit = createRateLimiter({ bucket: 'login', max: 20, windowMs: 15 * 60_000 });

export const POST = withApiHandler(
  { auth: 'none', body: credentialsSchema, rateLimit: loginRateLimit },
  async ({ body }) => {
    if (await loginFailures.isLocked(body.email)) {
      return jsonError('LOGIN_LOCKED', 'Too many failed attempts, please try again later', 429);
    }

    const user = await authenticate(body.email, body.password);
    if (!user) {
      await loginFailures.record(body.email);
      return jsonError(AuthErrorCode.INVALID_CREDENTIALS, 'Incorrect email or password', 401);
    }

    await loginFailures.clear(body.email);
    const session = await createSession(user.id);
    const token = createAccessToken(user.id, user.tokenVersion, session.id);
    const response = NextResponse.json(toUserResponse(user));
    setSessionCookie(response, token);
    return response;
  },
);
