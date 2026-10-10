/**
 * 鉴权共享 helper：双 token cookie 写入/清除 + 无状态鉴权。
 *
 * - setAuthCookies / clearAuthCookies：双 cookie（access 短 / refresh 长）
 * - getCurrentUser：access-only 校验（验签 + token_version 比对）
 * - authenticateWithRefresh：透明刷新入口——access 失效时用 refresh cookie
 *   重签新对，返回的 tokens 由 api-handler 附加到最终响应的 Set-Cookie
 *
 * 无状态设计：不查任何会话表；token_version（users 表）是唯一全局失效通道，
 * 登出只清 cookie。被盗 refresh 至多活到过期（7 天），已接受的取舍。
 *
 * 属性默认 SameSite=None + Secure：前后端分离部署下跨站携带 cookie 的硬约束
 * （None 必须配 Secure）；dev 下 localhost 属可信源，http 也能读写。
 * 纯 HTTP 部署（DISABLE_SECURE_COOKIE）必须去掉 Secure——浏览器对非 https
 * 来源拒收 Secure cookie，登录会"成功但永不生效"。
 */

import type { NextRequest } from 'next/server';

import {
  createAccessToken,
  createRefreshToken,
  getAccessTokenExpiryMinutes,
  getTokenExpiryDays,
  verifyAccessToken,
  verifyRefreshToken,
  type TokenPair,
} from '@deerflow-harness/auth';
import { getUserById } from '@deerflow-harness/auth';
import type { UserRecord } from '@deerflow-harness/auth';

export const ACCESS_COOKIE_NAME = 'access_token';
export const REFRESH_COOKIE_NAME = 'refresh_token';

/**
 * 纯 HTTP 部署开关（DISABLE_SECURE_COOKIE='1'/'true'，语义见 .env.production.example）。
 * http 下浏览器拒收带 Secure 的 cookie；而 SameSite=None 强制要求 Secure，
 * 所以去 Secure 必须同时降为 Lax——同源部署（页面与 API 同源直连）本就不需要 None。
 */
export function isSecureCookieDisabled(): boolean {
  const raw = process.env.DISABLE_SECURE_COOKIE;
  return raw === '1' || raw === 'true';
}

function cookieAttrs(): string {
  return isSecureCookieDisabled()
    ? 'Path=/; HttpOnly; SameSite=Lax'
    : 'Path=/; HttpOnly; Secure; SameSite=None';
}

/** JWT 是 base64url 字符集，无 ';' 等需转义字符，直接拼接即可 */
function cookieHeader(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; ${cookieAttrs()}; Max-Age=${maxAgeSeconds}`;
}

/**
 * 写入双 token cookie。用 headers.append 而非 NextResponse.cookies.set：
 * SSE 等 plain Response 没有 .cookies 属性，两条路径必须统一走原始 header。
 */
export function setAuthCookies(response: Response, tokens: TokenPair): void {
  response.headers.append(
    'Set-Cookie',
    cookieHeader(ACCESS_COOKIE_NAME, tokens.accessToken, getAccessTokenExpiryMinutes() * 60),
  );
  response.headers.append(
    'Set-Cookie',
    cookieHeader(REFRESH_COOKIE_NAME, tokens.refreshToken, getTokenExpiryDays() * 24 * 3600),
  );
}

/** 清除双 cookie：name/path/属性与写入时一致浏览器才会删除 */
export function clearAuthCookies(response: Response): void {
  response.headers.append('Set-Cookie', cookieHeader(ACCESS_COOKIE_NAME, '', 0));
  response.headers.append('Set-Cookie', cookieHeader(REFRESH_COOKIE_NAME, '', 0));
}

/**
 * access-only 鉴权：cookie → 验签 → 用户存在且 token_version 匹配。
 * 无 cookie / 验签失败 / 用户不存在 / 版本落后均返回 null。
 */
export async function getCurrentUser(request: NextRequest): Promise<UserRecord | null> {
  const token = request.cookies.get(ACCESS_COOKIE_NAME)?.value;
  if (!token) return null;

  const payload = verifyAccessToken(token);
  if (!payload) return null;

  const user = await getUserById(payload.sub);
  if (!user || user.tokenVersion !== payload.ver) return null;
  return user;
}

export interface AuthWithRefreshResult {
  user: UserRecord | null;
  /** access 失效但 refresh 有效时产出新对（调用方负责写入响应 cookie） */
  tokens?: TokenPair;
}

/**
 * 透明刷新入口：access 有效直接过；否则验 refresh cookie，通过则重签新对。
 * refresh 校验与 access 同标准（验签 + 用户存在 + token_version 匹配）——
 * 改密/重置后旧 refresh 同样失效。并发请求各自刷新各自成功（无状态，
 * 都有效，浏览器取最后一条 Set-Cookie），无害。
 */
export async function authenticateWithRefresh(
  request: NextRequest,
): Promise<AuthWithRefreshResult> {
  const user = await getCurrentUser(request);
  if (user) return { user };

  const refreshToken = request.cookies.get(REFRESH_COOKIE_NAME)?.value;
  if (!refreshToken) return { user: null };

  const payload = verifyRefreshToken(refreshToken);
  if (!payload) return { user: null };

  const refreshed = await getUserById(payload.sub);
  if (!refreshed || refreshed.tokenVersion !== payload.ver) return { user: null };

  return {
    user: refreshed,
    tokens: {
      accessToken: createAccessToken(refreshed.id, refreshed.tokenVersion),
      refreshToken: createRefreshToken(refreshed.id, refreshed.tokenVersion),
    },
  };
}
