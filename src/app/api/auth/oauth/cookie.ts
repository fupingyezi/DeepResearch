/**
 * OAuth state cookie（begin / callback 两条 [provider] 路由共用的非路由 helper）。
 *
 * state 只存在 cookie 里、无服务端存储：攻击者无法在 api 域种 cookie，
 * 回调 state 匹配 ⟺ 必然流经 begin 端点（CSRF 防线）。
 * SameSite=lax 而非 access_token 的 none：state 只在顶层导航（begin → provider
 * → callback）流动，不参与跨站 XHR，lax 覆盖该场景且更紧。
 */
import type { NextResponse } from 'next/server';

import { isSecureCookieDisabled } from '@/server/http';

export const OAUTH_STATE_COOKIE = 'oauth_state';
/** 10 分钟：覆盖一次完整授权往返（用户输入账号密码的时间在内） */
export const OAUTH_STATE_TTL_SECONDS = 600;

export function setOAuthStateCookie(response: NextResponse, state: string): void {
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: !isSecureCookieDisabled(),
    sameSite: 'lax',
    path: '/api/auth/oauth',
    maxAge: OAUTH_STATE_TTL_SECONDS,
  });
}

export function clearOAuthStateCookie(response: NextResponse): void {
  response.cookies.set(OAUTH_STATE_COOKIE, '', {
    httpOnly: true,
    secure: !isSecureCookieDisabled(),
    sameSite: 'lax',
    path: '/api/auth/oauth',
    maxAge: 0,
  });
}
