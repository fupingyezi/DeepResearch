/**
 * GET /api/auth/oauth/[provider] —— OAuth 登录入口（begin）。
 *
 * 302 到第三方授权页并种 state cookie；provider 未知/未配置 → 302 回
 * app 域登录页带 oauth_error=PROVIDER_DISABLED（未配置时登录页已隐藏按钮，
 * 直接访问 URL 也得到干净的拒绝，且不泄露哪些平台曾被配置过）。
 */
import { NextResponse } from 'next/server';

import { appBaseUrl, oauthRedirectUri } from '@/lib/app-origin';
import { withApiHandler } from '@/server/http';
import {
  OAuthServiceError,
  getOAuthService,
  type OAuthErrorCode,
} from '@/server/services/oauth-service';
import { setOAuthStateCookie } from '../cookie';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler({ auth: 'none' }, async ({ params, request }) => {
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
});
