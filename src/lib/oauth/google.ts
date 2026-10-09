/**
 * Google OAuth 适配器（Web application client，OpenID Connect userinfo）。
 *
 * 邮箱缺失不合成——Google 没有 GitHub noreply 那样的转发保证，合成地址
 * 只会造出永远收不到信的账号，交给 service 走 NO_EMAIL。
 */
import { OAuthAdapterError, type OAuthProviderAdapter, type OAuthUserInfo } from './types';
import { oauthFetch } from './http';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

interface GoogleUserinfo {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

export function createGoogleAdapter(): OAuthProviderAdapter {
  const env = () => ({
    clientId: process.env.OAUTH_GOOGLE_CLIENT_ID?.trim() ?? '',
    clientSecret: process.env.OAUTH_GOOGLE_CLIENT_SECRET?.trim() ?? '',
  });

  return {
    name: 'google',

    isConfigured() {
      const { clientId, clientSecret } = env();
      return Boolean(clientId && clientSecret);
    },

    buildAuthorizeUrl(state, redirectUri) {
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set('client_id', env().clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'openid email');
      url.searchParams.set('state', state);
      return url.toString();
    },

    async exchange(code, redirectUri) {
      const { clientId, clientSecret } = env();
      const tokenRes = await oauthFetch('google', 'token', TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }).toString(),
      });
      const tokenData = (await tokenRes.json()) as { access_token?: string };
      if (!tokenData.access_token) {
        throw new OAuthAdapterError('google', 'token', 'missing access_token');
      }

      const userRes = await oauthFetch('google', 'userinfo', USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const info = (await userRes.json()) as GoogleUserinfo;
      if (!info.sub) throw new OAuthAdapterError('google', 'userinfo', 'missing sub');

      return {
        providerUserId: info.sub,
        email: info.email ?? null,
        emailVerified: info.email_verified === true,
        displayName: info.name ?? null,
      } satisfies OAuthUserInfo;
    },
  };
}
