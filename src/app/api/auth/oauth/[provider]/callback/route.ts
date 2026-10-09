/**
 * GET /api/auth/oauth/[provider]/callback —— OAuth 回调。
 *
 * 换 token → 绑定决策 → 种会话 cookie → 302 app 域（成功去首页，失败去
 * /login?oauth_error=…）。GET 而非 POST：middleware 已对 /api/auth/* 放行，
 * 且 GET 不触发 withApiHandler 的 Origin 校验（顶层导航不携带 Origin）。
 *
 * state cookie 一次性：每条返回路径都清除，防重放。
 */
import { NextResponse } from 'next/server';

import { appBaseUrl, oauthRedirectUri } from '@/lib/app-origin';
import { setSessionCookie, withApiHandler } from '@/server/http';
import { createRateLimiter } from '@/server/http/rate-limit';
import { getAuthService } from '@/server/services/auth-service';
import {
  OAuthServiceError,
  getOAuthService,
  type OAuthErrorCode,
} from '@/server/services/oauth-service';
import { oauthCallbackQuerySchema } from '@/server/validation/schemas';
import { OAUTH_STATE_COOKIE, clearOAuthStateCookie } from '../../cookie';

export const dynamic = 'force-dynamic';

const callbackRateLimit = createRateLimiter({
  bucket: 'oauth-callback',
  max: 30,
  windowMs: 15 * 60_000,
});

export const GET = withApiHandler(
  { auth: 'none', query: oauthCallbackQuerySchema, rateLimit: callbackRateLimit },
  async ({ params, query, request }) => {
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
      const token = await getAuthService().issueSessionToken(user);
      const response = NextResponse.redirect(`${app}/`, 302);
      setSessionCookie(response, token);
      return clearAnd(response);
    } catch (error) {
      return clearAnd(
        redirect(error instanceof OAuthServiceError ? error.code : 'EXCHANGE_FAILED'),
      );
    }
  },
);
