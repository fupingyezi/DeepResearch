/**
 * Auth API 路由的共享 helper。
 *
 * - COOKIE_NAME：HttpOnly 会话 cookie 名
 * - setSessionCookie / clearSessionCookie：写入/清除 cookie
 * - getCurrentUser：从请求 cookie 解析 JWT → 校验 token_version → 返回当前用户
 * - jsonError：统一结构化错误响应
 *
 * token_version 校验：JWT 内的 ver 必须与 DB 中用户当前 tokenVersion 一致，
 * 改密码后旧 token（ver 落后）即失效。
 */

import { NextRequest, NextResponse } from 'next/server';

import { decodeToken, getTokenExpiryDays } from '@deerflow-harness/auth';
import { getUserById } from '@deerflow-harness/auth';
import type { AuthErrorCode, UserRecord } from '@deerflow-harness/auth';

export const COOKIE_NAME = 'access_token';

export function setSessionCookie(response: NextResponse, token: string): void {
  const isProd = process.env.NODE_ENV === 'production';
  response.cookies.set({
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: getTokenExpiryDays() * 24 * 3600,
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: COOKIE_NAME,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

/**
 * 从请求 cookie 解析当前用户。无 cookie / 验签失败 / 用户不存在 / token_version
 * 不匹配 均返回 null。
 */
export async function getCurrentUser(request: NextRequest): Promise<UserRecord | null> {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const payload = decodeToken(token);
  if (!payload) return null;

  const user = await getUserById(payload.sub);
  if (!user || user.tokenVersion !== payload.ver) return null;

  return user;
}

export function jsonError(code: AuthErrorCode, message: string, status: number): NextResponse {
  return NextResponse.json({ code, message }, { status });
}
