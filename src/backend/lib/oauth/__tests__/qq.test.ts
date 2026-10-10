import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OAuthAdapterError } from '../types';
import { createQqAdapter } from '../qq';

function textRes(body: string, contentType = 'text/plain'): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': contentType } });
}

function jsonRes(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const REDIRECT_URI = 'http://localhost:3000/api/auth/oauth/qq/callback';

beforeEach(() => {
  process.env.OAUTH_QQ_CLIENT_ID = 'cid';
  process.env.OAUTH_QQ_CLIENT_SECRET = 'csec';
});

afterEach(() => {
  delete process.env.OAUTH_QQ_CLIENT_ID;
  delete process.env.OAUTH_QQ_CLIENT_SECRET;
  vi.unstubAllGlobals();
});

describe('isConfigured', () => {
  it('client_id / client_secret 缺一不可', () => {
    const adapter = createQqAdapter();
    expect(adapter.isConfigured()).toBe(true);
    delete process.env.OAUTH_QQ_CLIENT_ID;
    expect(adapter.isConfigured()).toBe(false);
  });
});

describe('buildAuthorizeUrl', () => {
  it('拼出 authorize URL', () => {
    const url = new URL(createQqAdapter().buildAuthorizeUrl('state-1', REDIRECT_URI));
    expect(url.origin + url.pathname).toBe('https://graph.qq.com/oauth2.0/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('state')).toBe('state-1');
  });
});

describe('exchange', () => {
  it('成功链路：JSON token → JSONP openid → userinfo；合成邮箱 + verified', async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonRes({ access_token: 'AT1', expires_in: '7776000' }))
      .mockResolvedValueOnce(textRes('callback( {"client_id":"cid","openid":"OPENID123"} );'))
      .mockResolvedValueOnce(jsonRes({ ret: 0, msg: '', nickname: '小Q' }));
    vi.stubGlobal('fetch', fetchMock);

    const info = await createQqAdapter().exchange('code', REDIRECT_URI);

    expect(info).toEqual({
      providerUserId: 'OPENID123',
      email: 'OPENID123@oauth.qq.local',
      emailVerified: true,
      displayName: '小Q',
    });
    // openid 用 GET 带 access_token；userinfo 带 access_token + oauth_consumer_key + openid
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://graph.qq.com/oauth2.0/me?access_token=AT1',
      expect.anything(),
    );
    const userinfoUrl = (fetchMock.mock.calls[2] as unknown[])[0] as string;
    expect(userinfoUrl).toContain('https://graph.qq.com/user/get_user_info');
    expect(userinfoUrl).toContain('access_token=AT1');
    expect(userinfoUrl).toContain('oauth_consumer_key=cid');
    expect(userinfoUrl).toContain('openid=OPENID123');
  });

  it('token 返回 urlencoded 文本（QQ 历史格式）也能解析', async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(textRes('access_token=AT2&expires_in=7776000&refresh_token=RT'))
      .mockResolvedValueOnce(textRes('callback( {"openid":"OPENID2"} );'))
      .mockResolvedValueOnce(jsonRes({ ret: 0, nickname: null }));
    vi.stubGlobal('fetch', fetchMock);

    const info = await createQqAdapter().exchange('code', REDIRECT_URI);
    expect(info.providerUserId).toBe('OPENID2');
    expect(info.displayName).toBeNull();
  });

  it('token 返回 JSON 错误体 → OAuthAdapterError（stage=token）', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonRes({ error: 100015, error_description: 'code is reused error' })),
    );
    await expect(createQqAdapter().exchange('code', REDIRECT_URI)).rejects.toMatchObject({
      provider: 'qq',
      stage: 'token',
    });
  });

  it('token 返回 JSONP 包装的错误体（200 带错）→ OAuthAdapterError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(textRes('callback( {"error":100015,"error_description":"bad"} );')),
    );
    await expect(createQqAdapter().exchange('code', REDIRECT_URI)).rejects.toMatchObject({
      provider: 'qq',
      stage: 'token',
    });
  });

  it('token 响应无法解析 → OAuthAdapterError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textRes('<html>gateway error</html>')));
    await expect(createQqAdapter().exchange('code', REDIRECT_URI)).rejects.toMatchObject({
      provider: 'qq',
      stage: 'token',
    });
  });

  it('openid 响应格式损坏 → OAuthAdapterError（stage=openid）', async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonRes({ access_token: 'AT1' }))
      .mockResolvedValueOnce(textRes('not jsonp at all'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createQqAdapter().exchange('code', REDIRECT_URI)).rejects.toMatchObject({
      provider: 'qq',
      stage: 'openid',
    });
  });

  it('get_user_info ret != 0 → OAuthAdapterError（stage=userinfo）', async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonRes({ access_token: 'AT1' }))
      .mockResolvedValueOnce(textRes('callback( {"openid":"OPENID3"} );'))
      .mockResolvedValueOnce(jsonRes({ ret: 100013, msg: 'invalid openid' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createQqAdapter().exchange('code', REDIRECT_URI)).rejects.toMatchObject({
      provider: 'qq',
      stage: 'userinfo',
    });
  });

  it('token 非 2xx → OAuthAdapterError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 503 })));
    await expect(createQqAdapter().exchange('code', REDIRECT_URI)).rejects.toBeInstanceOf(
      OAuthAdapterError,
    );
  });
});
