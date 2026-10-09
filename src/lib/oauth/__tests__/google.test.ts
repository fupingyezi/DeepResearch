import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OAuthAdapterError } from '../types';
import { createGoogleAdapter } from '../google';

function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const REDIRECT_URI = 'http://localhost:3000/api/auth/oauth/google/callback';

beforeEach(() => {
  process.env.OAUTH_GOOGLE_CLIENT_ID = 'cid';
  process.env.OAUTH_GOOGLE_CLIENT_SECRET = 'csec';
});

afterEach(() => {
  delete process.env.OAUTH_GOOGLE_CLIENT_ID;
  delete process.env.OAUTH_GOOGLE_CLIENT_SECRET;
  vi.unstubAllGlobals();
});

describe('isConfigured', () => {
  it('client_id / client_secret 缺一不可', () => {
    const adapter = createGoogleAdapter();
    expect(adapter.isConfigured()).toBe(true);
    delete process.env.OAUTH_GOOGLE_CLIENT_SECRET;
    expect(adapter.isConfigured()).toBe(false);
  });
});

describe('buildAuthorizeUrl', () => {
  it('拼出 authorize URL（openid email scope）', () => {
    const url = new URL(createGoogleAdapter().buildAuthorizeUrl('state-1', REDIRECT_URI));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email');
    expect(url.searchParams.get('state')).toBe('state-1');
  });
});

describe('exchange', () => {
  it('成功链路：token（表单）→ userinfo，email_verified 透传', async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonRes({ access_token: 'AT1' }))
      .mockResolvedValueOnce(
        jsonRes({ sub: 'g-sub-1', email: 'g@test.local', email_verified: true, name: 'G' }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const info = await createGoogleAdapter().exchange('code', REDIRECT_URI);

    expect(info).toEqual({
      providerUserId: 'g-sub-1',
      email: 'g@test.local',
      emailVerified: true,
      displayName: 'G',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      }),
    );
    // 表单体包含 code / client 凭据 / grant_type
    const body = (fetchMock.mock.calls[0] as unknown[])[1] as { body: string };
    expect(body.body).toContain('grant_type=authorization_code');
    expect(body.body).toContain('code=code');
    expect(body.body).toContain('client_id=cid');
    expect(body.body).toContain(`redirect_uri=${encodeURIComponent(REDIRECT_URI)}`);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://openidconnect.googleapis.com/v1/userinfo',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer AT1' }),
      }),
    );
  });

  it('email_verified=false → emailVerified=false', async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonRes({ access_token: 'AT1' }))
      .mockResolvedValueOnce(
        jsonRes({ sub: 'g-sub-1', email: 'g@test.local', email_verified: false }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const info = await createGoogleAdapter().exchange('code', REDIRECT_URI);
    expect(info.emailVerified).toBe(false);
  });

  it('userinfo 无邮箱 → email null（不合成，交给 NO_EMAIL）', async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonRes({ access_token: 'AT1' }))
      .mockResolvedValueOnce(jsonRes({ sub: 'g-sub-1', name: 'NoMail' }));
    vi.stubGlobal('fetch', fetchMock);

    const info = await createGoogleAdapter().exchange('code', REDIRECT_URI);
    expect(info.email).toBeNull();
  });

  it('userinfo 非 2xx → OAuthAdapterError（stage=userinfo）', async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonRes({ access_token: 'AT1' }))
      .mockResolvedValueOnce(new Response('invalid_token', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createGoogleAdapter().exchange('code', REDIRECT_URI)).rejects.toMatchObject({
      provider: 'google',
      stage: 'userinfo',
    });
  });

  it('token 响应缺 access_token → OAuthAdapterError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes({ error: 'invalid_grant' })));
    await expect(createGoogleAdapter().exchange('code', REDIRECT_URI)).rejects.toBeInstanceOf(
      OAuthAdapterError,
    );
  });
});
