/**
 * POST /api/auth/logout —— 清除会话 cookie。
 */

import { NextResponse } from 'next/server';

import { clearSessionCookie, withApiHandler } from '@/server/http';

export { OPTIONS } from '@/server/http/preflight';

export const POST = withApiHandler({ auth: 'none' }, async () => {
  const response = NextResponse.json({ message: 'Successfully logged out' });
  clearSessionCookie(response);
  return response;
});
