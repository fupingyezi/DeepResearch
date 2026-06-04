/**
 * GET /api/auth/me —— 返回当前登录用户信息，未登录返回 401。
 */

import { NextRequest, NextResponse } from 'next/server';

import { AuthErrorCode, toUserResponse } from '@deerflow-harness/auth';
import { getCurrentUser, jsonError } from '../_helpers';

export async function GET(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return jsonError(AuthErrorCode.UNAUTHENTICATED, 'Not authenticated', 401);
  }
  return NextResponse.json(toUserResponse(user));
}
