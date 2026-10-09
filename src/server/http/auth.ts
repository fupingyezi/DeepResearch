/**
 * Auth API 路由的共享 helper。
 *
 * - COOKIE_NAME：HttpOnly 会话 cookie 名
 * - setSessionCookie / clearSessionCookie：写入/清除 cookie
 * - getCurrentUser：从请求 cookie 解析 JWT → 校验 token_version → 返回当前用户
 *
 * token_version 校验：JWT 内的 ver 必须与 DB 中用户当前 tokenVersion 一致，
 * 改密码后旧 token（ver 落后）即失效。
 *
 * jsonError 在同目录 errors.ts，经 index barrel 统一导出。
 */

import { NextRequest, NextResponse } from 'next/server';

import { decodeToken, getTokenExpiryDays } from '@deerflow-harness/auth';
import { getUserById } from '@deerflow-harness/auth';
import { isSessionActive } from '@deerflow-harness/auth';
import type { UserRecord } from '@deerflow-harness/auth';

export const COOKIE_NAME = 'access_token';

export function setSessionCookie(response: NextResponse, token: string): void {
  response.cookies.set({
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    // 前后端分离后 cookie 跨站发送必须 SameSite=None，而浏览器强制 None 必须配
    // Secure。localhost/127.0.0.1 属可信源，dev 下 http 也能读写 Secure cookie；
    // 生产必须已上 TLS，否则浏览器拒收该 cookie、登录直接失效。
    secure: true,
    sameSite: 'none',
    path: '/',
    maxAge: getTokenExpiryDays() * 24 * 3600,
  });
}

export function clearSessionCookie(response: NextResponse): void {
  // name/path 与写入时一致才会被浏览器删除；SameSite/Secure 同参保险
  response.cookies.set({
    name: COOKIE_NAME,
    value: '',
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
    maxAge: 0,
  });
}

/**
 * 从请求 cookie 解析当前用户。无 cookie / 验签失败 / 用户不存在 / token_version
 * 不匹配 / 会话已吊销或过期 均返回 null。
 */
export async function getCurrentUser(request: NextRequest): Promise<UserRecord | null> {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const payload = decodeToken(token);
  if (!payload) return null;

  const user = await getUserById(payload.sub);
  if (!user || user.tokenVersion !== payload.ver) return null;

  // 会话吊销校验：登出 / 服务端吊销后立即失效，不依赖 JWT 过期
  if (!(await isSessionActive(payload.sid))) return null;

  return user;
}
