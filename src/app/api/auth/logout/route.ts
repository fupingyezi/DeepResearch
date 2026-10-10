/**
 * POST /api/auth/logout —— 清除双 token cookie。
 *
 * 无状态设计下登出没有服务端吊销通道：清 cookie 即完成登出；已被拷贝出去的
 * token 至多活到各自过期（access ≤15min / refresh ≤7d）。全局失效走
 * users.token_version（改密 / 重置密码自增）。恒 200——登出永不失败。
 */

import { NextResponse } from 'next/server';

import { clearAuthCookies, withApiHandler } from '@/server/http';

export { OPTIONS } from '@/server/http/preflight';

export const POST = withApiHandler({ auth: 'none' }, async () => {
  const response = NextResponse.json({ message: 'Successfully logged out' });
  clearAuthCookies(response);
  return response;
});
