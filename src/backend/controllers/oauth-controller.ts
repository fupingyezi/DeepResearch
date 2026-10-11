/**
 * OAuth 域 HTTP 层逻辑（自 src/app/api/auth/oauth/**route.ts 整体抽出；
 * 原 src/app/api/auth/oauth/cookie.ts 的 state cookie 助手一并并入本文件）。
 *
 * 各 handler 是裸函数：不感知 withApiHandler（鉴权 / query 解析 / 限流都在
 * route.ts 的 withApiHandler 选项里完成），输入即解析后的 ctx。route.ts
 * 已退化为薄适配器，只保留 withApiHandler 选项、Next 配置导出（dynamic /
 * OPTIONS），本文件是这些路由的唯一逻辑来源。
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { ApiRouteHandler } from '@/backend/http';
import { createRateLimiter, isSecureCookieDisabled, setAuthCookies } from '@/backend/http';
import { appBaseUrl, oauthRedirectUri } from '@/backend/lib/app-origin';
import { getAuthService } from '@/backend/services/auth-service';
import {
  OAuthServiceError,
  getOAuthService,
  type OAuthErrorCode,
} from '@/backend/services/oauth-service';
import { oauthCallbackQuerySchema } from '@/backend/validation/schemas';

/**
 * OAuth state cookie（begin / callback 两个 [provider] handler 共用的非路由 helper）。
 *
 * state 只存在 cookie 里、无服务端存储：攻击者无法在 api 域种 cookie，
 * 回调 state 匹配 ⟺ 必然流经 begin 端点（CSRF 防线）。
 * SameSite=lax 而非 access_token 的 none：state 只在顶层导航（begin → provider
 * → callback）流动，不参与跨站 XHR，lax 覆盖该场景且更紧。
 */
const OAUTH_STATE_COOKIE = 'oauth_state';
/** 10 分钟：覆盖一次完整授权往返（用户输入账号密码的时间在内） */
const OAUTH_STATE_TTL_SECONDS = 600;

function setOAuthStateCookie(response: NextResponse, state: string): void {
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: !isSecureCookieDisabled(),
    sameSite: 'lax',
    path: '/api/auth/oauth',
    maxAge: OAUTH_STATE_TTL_SECONDS,
  });
}

function clearOAuthStateCookie(response: NextResponse): void {
  response.cookies.set(OAUTH_STATE_COOKIE, '', {
    httpOnly: true,
    secure: !isSecureCookieDisabled(),
    sameSite: 'lax',
    path: '/api/auth/oauth',
    maxAge: 0,
  });
}

/**
 * GET /api/auth/oauth/[provider] —— OAuth 登录入口（begin）。
 *
 * 302 到第三方授权页并种 state cookie；provider 未知/未配置 → 302 回
 * app 域登录页带 oauth_error=PROVIDER_DISABLED（未配置时登录页已隐藏按钮，
 * 直接访问 URL 也得到干净的拒绝，且不泄露哪些平台曾被配置过）。
 */
export const begin: ApiRouteHandler<undefined, undefined> = async ({ params, request }) => {
  // 302 目标恒为 env 决定的 app 域（同源部署回落请求自身 origin）：
  // 不读任何用户可控的 redirect/return_to，open-redirect 从构造上关闭
  const app = appBaseUrl() || request.nextUrl.origin;
  const fail = (code: OAuthErrorCode) =>
    NextResponse.redirect(`${app}/login?oauth_error=${code}`, 302);

  try {
    const redirectUri = oauthRedirectUri(request, params.provider);
    const { redirectUrl, state } = getOAuthService().begin(params.provider, redirectUri);
    const response = NextResponse.redirect(redirectUrl, 302);
    setOAuthStateCookie(response, state);
    return response;
  } catch (error) {
    return fail(error instanceof OAuthServiceError ? error.code : 'EXCHANGE_FAILED');
  }
};

/**
 * GET /api/auth/oauth/[provider]/callback —— OAuth 回调。
 *
 * 换 token → 绑定决策 → 种会话 cookie → 302 app 域（成功去首页，失败去
 * /login?oauth_error=…）。GET 而非 POST：middleware 已对 /api/auth/* 放行，
 * 且 GET 不触发 withApiHandler 的 Origin 校验（顶层导航不携带 Origin）。
 *
 * state cookie 一次性：每条返回路径都清除，防重放。
 */
export const callback: ApiRouteHandler<
  undefined,
  z.infer<typeof oauthCallbackQuerySchema>
> = async ({ params, query, request }) => {
  const app = appBaseUrl() || request.nextUrl.origin;
  const redirect = (code: OAuthErrorCode) =>
    NextResponse.redirect(`${app}/login?oauth_error=${code}`, 302);
  const clearAnd = (response: NextResponse) => {
    clearOAuthStateCookie(response);
    return response;
  };

  // provider 侧失败（access_denied = 用户取消授权，也走这里）
  if (query.error) {
    console.warn(
      '[oauth] provider error:',
      params.provider,
      query.error,
      query.error_description ?? '',
    );
    return clearAnd(redirect('PROVIDER_ERROR'));
  }
  if (!query.code) return clearAnd(redirect('EXCHANGE_FAILED'));

  const cookieState = request.cookies.get(OAUTH_STATE_COOKIE)?.value ?? null;
  try {
    const user = await getOAuthService().handleCallback(
      params.provider,
      query.code,
      query.state ?? null,
      cookieState,
      oauthRedirectUri(request, params.provider),
    );
    const tokens = getAuthService().issueTokenPair(user);
    const response = NextResponse.redirect(`${app}/`, 302);
    setAuthCookies(response, tokens);
    return clearAnd(response);
  } catch (error) {
    return clearAnd(redirect(error instanceof OAuthServiceError ? error.code : 'EXCHANGE_FAILED'));
  }
};

/**
 * GET /api/auth/oauth/providers —— 下发已配置的 OAuth provider 列表。
 *
 * 登录页据此渲染第三方登录按钮：一个平台都未配置时返回空数组，按钮全部隐藏。
 * 静态段优先于同目录的 [provider] 动态段，路由无冲突。
 */
export const listProviders: ApiRouteHandler<undefined, undefined> = async () =>
  NextResponse.json({ providers: getOAuthService().listConfiguredProviders() });

/** 本域路由的限流器（route.ts 的 withApiHandler 选项引用）。 */
export const oauthRateLimits = {
  callback: createRateLimiter({
    bucket: 'oauth-callback',
    max: 30,
    windowMs: 15 * 60_000,
  }),
};
