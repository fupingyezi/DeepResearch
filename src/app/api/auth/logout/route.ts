/**
 * POST /api/auth/logout —— 吊销会话并清除 cookie。
 *
 * 不验签解析 token 只为取出 sid（token 可能已过期，吊销过期会话幂等无害）；
 * 无 token / 解析失败也恒清除 cookie 并返回 200——登出永不失败。
 */

import { NextResponse } from 'next/server';

import { decodeTokenUnverified, revokeSession } from '@deerflow-harness/auth';
import { clearSessionCookie, COOKIE_NAME, withApiHandler } from '@/server/http';

export { OPTIONS } from '@/server/http/preflight';

export const POST = withApiHandler({ auth: 'none' }, async ({ request }) => {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (token) {
    const payload = decodeTokenUnverified(token);
    if (payload) {
      await revokeSession(payload.sid);
    }
  }
  const response = NextResponse.json({ message: 'Successfully logged out' });
  clearSessionCookie(response);
  return response;
});
