import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OAuthAdapterError } from '../types';
import { createGithubAdapter } from '../github';

function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const REDIRECT_URI = 'http://localhost:3000/api/auth/oauth/github/callback';

beforeEach(() => {
  process.env.OAUTH_GITHUB_CLIENT_ID = 'cid';
  process.env.OAUTH_GITHUB_CLIENT_SECRET = 'csec';
});

afterEach(() => {
  delete process.env.OAUTH_GITHUB_CLIENT_ID;
  delete process.env.OAUTH_GITHUB_CLIENT_SECRET;
  vi.unstubAllGlobals();
});

describe('isConfigured', () => {
  it('client_id / client_secret 缺一不可', () => {
    const adapter = createGithubAdapter();
    expect(adapter.isConfigured()).toBe(true);

    delete process.env.OAUTH_GITHUB_CLIENT_ID;
    expect(adapter.isConfigured()).toBe(false);

    process.env.OAUTH_GITHUB_CLIENT_ID = 'cid';
    delete process.env.OAUTH_GITHUB_CLIENT_SECRET;
    expect(adapter.isConfigured()).toBe(false);
  });
});

describe('buildAuthorizeUrl', () => {
  it('拼出 authorize URL（client_id/redirect_uri/scope/state）', () => {
    const url = new URL(createGithubAdapter().buildAuthorizeUrl('state-1', REDIRECT_URI));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('scope')).toBe('user:email');
    expect(url.searchParams.get('state')).toBe('state-1');
  });
});

describe('exchange', () => {
  it('成功链路：token → user → emails，primary+verified 优先', async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonRes({ access_token: 'AT1' }))
      .mockResolvedValueOnce(jsonRes({ id: 123, login: 'Alice', name: 'Alice W' }))
      .mockResolvedValueOnce(
        jsonRes([
          { email: 'other@test.local', primary: false, verified: true },
          { email: 'primary@test.local', primary: true, verified: true },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const info = await createGithubAdapter().exchange('code', REDIRECT_URI);

    expect(info).toEqual({
      providerUserId: '123',
      email: 'primary@test.local',
      emailVerified: true,
      displayName: 'Alice W',
    });

    // token 交换：JSON body + Accept: application/json
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://github.com/login/oauth/access_token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Accept: 'application/json' }),
        body: JSON.stringify({
          client_id: 'cid',
          client_secret: 'csec',
          code: 'code',
          redirect_uri: REDIRECT_URI,
        }),
      }),
    );
    // user 与 emails 走 Bearer
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/user',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer AT1' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://api.github.com/user/emails',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer AT1' }),
      }),
    );
  });

  it('primary 未验证但存在其他 verified → 取该 verified', async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonRes({ access_token: 'AT1' }))
      .mockResolvedValueOnce(jsonRes({ id: 123, login: 'alice', name: null }))
      .mockResolvedValueOnce(
        jsonRes([
          { email: 'unverified@test.local', primary: true, verified: false },
          { email: 'verified@test.local', primary: false, verified: true },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const info = await createGithubAdapter().exchange('code', REDIRECT_URI);
    expect(info.email).toBe('verified@test.local');
    expect(info.emailVerified).toBe(true);
  });

  it('无 verified 邮箱 → 合成 noreply 且 emailVerified=false', async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonRes({ access_token: 'AT1' }))
      .mockResolvedValueOnce(jsonRes({ id: 123, login: 'Alice', name: null }))
      .mockResolvedValueOnce(
        jsonRes([{ email: 'unverified@test.local', primary: true, verified: false }]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const info = await createGithubAdapter().exchange('code', REDIRECT_URI);
    expect(info.email).toBe('123+alice@users.noreply.github.com');
    expect(info.emailVerified).toBe(false);
    expect(info.displayName).toBe('Alice');
  });

  it('emails 拉取失败 → 回落合成 noreply，不阻断登录', async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonRes({ access_token: 'AT1' }))
      .mockResolvedValueOnce(jsonRes({ id: 123, login: 'alice', name: null }))
      .mockResolvedValueOnce(new Response('rate limited', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    const info = await createGithubAdapter().exchange('code', REDIRECT_URI);
    expect(info.email).toBe('123+alice@users.noreply.github.com');
    expect(info.emailVerified).toBe(false);
  });

  it('token 交换非 2xx → OAuthAdapterError（provider=github, stage=token）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad', { status: 401 })));

    await expect(createGithubAdapter().exchange('code', REDIRECT_URI)).rejects.toMatchObject({
      name: 'OAuthAdapterError',
      provider: 'github',
      stage: 'token',
    });
  });

  it('token 响应缺 access_token → OAuthAdapterError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes({ error: 'bad_verification_code' })));

    await expect(createGithubAdapter().exchange('code', REDIRECT_URI)).rejects.toBeInstanceOf(
      OAuthAdapterError,
    );
  });
});
