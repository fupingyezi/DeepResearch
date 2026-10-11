/**
 * GitHub OAuth 适配器（OAuth App 流程）。
 *
 * 邮箱策略：/user/emails 里优先 primary+verified，其次任一 verified；
 * 都没有 → 官方合成 `${id}+${login}@users.noreply.github.com`——GitHub 会
 * 把该地址的邮件转发到用户真实邮箱，重发验证邮件的闭环仍然可用，故
 * 合成地址记 emailVerified=false（而非直接跳过验证）。
 */
import { OAuthAdapterError, type OAuthProviderAdapter, type OAuthUserInfo } from './types';
import { oauthFetch } from './http';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const EMAILS_URL = 'https://api.github.com/user/emails';

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export function createGithubAdapter(): OAuthProviderAdapter {
  const env = () => ({
    clientId: process.env.OAUTH_GITHUB_CLIENT_ID?.trim() ?? '',
    clientSecret: process.env.OAUTH_GITHUB_CLIENT_SECRET?.trim() ?? '',
  });

  return {
    name: 'github',

    isConfigured() {
      const { clientId, clientSecret } = env();
      return Boolean(clientId && clientSecret);
    },

    buildAuthorizeUrl(state, redirectUri) {
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set('client_id', env().clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', 'user:email');
      url.searchParams.set('state', state);
      return url.toString();
    },

    async exchange(code, redirectUri) {
      const { clientId, clientSecret } = env();
      const tokenRes = await oauthFetch('github', 'token', TOKEN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
      const tokenData = (await tokenRes.json()) as { access_token?: string };
      if (!tokenData.access_token) {
        throw new OAuthAdapterError('github', 'token', 'missing access_token');
      }
      const accessToken = tokenData.access_token;

      const userRes = await oauthFetch('github', 'user', USER_URL, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
      });
      const user = (await userRes.json()) as GitHubUser;
      if (!user.id) throw new OAuthAdapterError('github', 'user', 'missing user id');

      let email: string | null = null;
      try {
        const emailsRes = await oauthFetch('github', 'emails', EMAILS_URL, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github+json',
          },
        });
        const emails = (await emailsRes.json()) as GitHubEmail[];
        const primary = emails.find((e) => e.primary && e.verified);
        const anyVerified = emails.find((e) => e.verified);
        email = (primary ?? anyVerified)?.email ?? null;
      } catch (error) {
        // 邮箱列表拉取失败不阻断登录：回落合成 noreply 地址
        if (!(error instanceof OAuthAdapterError)) throw error;
      }

      return {
        providerUserId: String(user.id),
        email: email ?? `${user.id}+${user.login.toLowerCase()}@users.noreply.github.com`,
        emailVerified: email !== null,
        displayName: user.name ?? user.login,
      } satisfies OAuthUserInfo;
    },
  };
}
