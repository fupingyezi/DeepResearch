/**
 * QQ 互联适配器。流程特殊：token 之后要先拿 openid（/oauth2.0/me，JSONP），
 * 再取用户信息；get_user_info **不返回邮箱**——合成 `${openid}@oauth.qq.local`
 * 作为账号邮箱（对 openid 确定：同一 QQ 恒收敛同一行），置 emailVerified=true
 * 避免常驻验证横幅（合成地址收不到信，改邮箱走 change-password 的 newEmail）。
 *
 * providerUserId 用 openid 而非 unionid：unionid 跨应用但本系统只有一个 QQ
 * 应用，openid 在此范围内稳定且是接口主键，语义更直接。
 */
import { OAuthAdapterError, type OAuthProviderAdapter, type OAuthUserInfo } from './types';
import { oauthFetch } from './http';

const AUTHORIZE_URL = 'https://graph.qq.com/oauth2.0/authorize';
const TOKEN_URL = 'https://graph.qq.com/oauth2.0/token';
const OPENID_URL = 'https://graph.qq.com/oauth2.0/me';
const USERINFO_URL = 'https://graph.qq.com/user/get_user_info';

/** QQ 部分端点返回 JSONP（callback( {...} );），剥壳取内部 JSON 对象。 */
function unwrapJsonp(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('not a jsonp object');
  return JSON.parse(text.slice(start, end + 1));
}

interface QqTokenError {
  error?: string;
  error_description?: string;
}

export function createQqAdapter(): OAuthProviderAdapter {
  const env = () => ({
    clientId: process.env.OAUTH_QQ_CLIENT_ID?.trim() ?? '',
    clientSecret: process.env.OAUTH_QQ_CLIENT_SECRET?.trim() ?? '',
  });

  return {
    name: 'qq',

    isConfigured() {
      const { clientId, clientSecret } = env();
      return Boolean(clientId && clientSecret);
    },

    buildAuthorizeUrl(state, redirectUri) {
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', env().clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      return url.toString();
    },

    async exchange(code, redirectUri) {
      const { clientId, clientSecret } = env();
      const tokenRes = await oauthFetch('qq', 'token', TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
          fmt: 'json',
        }).toString(),
      });
      // QQ 的 200 响应也可能携带错误，且历史返回体是 urlencoded 文本而非 JSON：
      // 依次试 JSON（fmt=json）→ urlencoded → JSONP 剥壳取错误，全失败才算失败
      const text = await tokenRes.text();
      let accessToken: string | null = null;
      try {
        const data = JSON.parse(text) as { access_token?: string } & QqTokenError;
        accessToken = data.access_token ?? null;
        if (!accessToken && data.error) {
          throw new OAuthAdapterError(
            'qq',
            'token',
            `${data.error}: ${data.error_description ?? ''}`,
          );
        }
      } catch (error) {
        if (error instanceof OAuthAdapterError) throw error;
        if (text.includes('access_token=')) {
          accessToken = new URLSearchParams(text).get('access_token');
        } else {
          try {
            const err = unwrapJsonp(text) as QqTokenError;
            if (err.error) {
              throw new OAuthAdapterError(
                'qq',
                'token',
                `${err.error}: ${err.error_description ?? ''}`,
              );
            }
          } catch (inner) {
            if (inner instanceof OAuthAdapterError) throw inner;
          }
        }
      }
      if (!accessToken) throw new OAuthAdapterError('qq', 'token', 'missing access_token');

      const openidRes = await oauthFetch(
        'qq',
        'openid',
        `${OPENID_URL}?access_token=${encodeURIComponent(accessToken)}`,
      );
      const openidText = await openidRes.text();
      let openid: string;
      try {
        const data = unwrapJsonp(openidText) as { openid?: string };
        if (!data.openid) throw new Error('missing openid');
        openid = data.openid;
      } catch (error) {
        throw new OAuthAdapterError('qq', 'openid', `parse failed: ${(error as Error).message}`);
      }

      const userRes = await oauthFetch(
        'qq',
        'userinfo',
        `${USERINFO_URL}?access_token=${encodeURIComponent(accessToken)}` +
          `&oauth_consumer_key=${encodeURIComponent(clientId)}` +
          `&openid=${encodeURIComponent(openid)}`,
      );
      const info = (await userRes.json()) as { ret?: number; msg?: string; nickname?: string };
      if (info.ret !== 0) {
        throw new OAuthAdapterError('qq', 'userinfo', `${info.ret}: ${info.msg ?? 'unknown'}`);
      }

      return {
        providerUserId: openid,
        email: `${openid}@oauth.qq.local`,
        emailVerified: true,
        displayName: info.nickname ?? null,
      } satisfies OAuthUserInfo;
    },
  };
}
