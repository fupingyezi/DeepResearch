/**
 * POST /api/auth/logout —— 清除会话 cookie。
 */

import { NextResponse } from 'next/server';

import { clearSessionCookie } from '../_helpers';

export async function POST() {
  const response = NextResponse.json({ message: 'Successfully logged out' });
  clearSessionCookie(response);
  return response;
}
