/**
 * GET /api/auth/me —— 返回当前登录用户信息，未登录返回 401。
 */

import { NextResponse } from 'next/server';

import { toUserResponse } from '@deerflow-harness/auth';
import { withApiHandler } from '@/server/http';

export const GET = withApiHandler({}, async ({ user }) => {
  return NextResponse.json(toUserResponse(user!));
});
