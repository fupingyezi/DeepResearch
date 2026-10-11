import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';

import { applyCorsHeaders, isOriginAllowed } from '../cors';

function fakeRequest(headers: Record<string, string>) {
  const map = new Map(Object.entries(headers));
  return {
    headers: { get: (name: string) => map.get(name) ?? null },
  } as unknown as NextRequest;
}

beforeEach(() => {
  delete process.env.CORS_ALLOWED_ORIGINS;
});

afterEach(() => {
  delete process.env.CORS_ALLOWED_ORIGINS;
});

describe('isOriginAllowed', () => {
  it('无 Origin → 放行（非浏览器客户端，鉴权在前）', () => {
    expect(isOriginAllowed(fakeRequest({ host: 'app.example.com' }))).toBe(true);
  });

  it('HTTP 直连同源 → 放行', () => {
    expect(
      isOriginAllowed(fakeRequest({ origin: 'http://1.2.3.4:3000', host: '1.2.3.4:3000' })),
    ).toBe(true);
  });

  it('TLS 反代同源（x-forwarded-proto=https）→ 放行', () => {
    expect(
      isOriginAllowed(
        fakeRequest({
          origin: 'https://app.example.com',
          host: 'app.example.com',
          'x-forwarded-proto': 'https',
        }),
      ),
    ).toBe(true);
  });

  it('跨域且不在白名单 → 拒绝', () => {
    expect(
      isOriginAllowed(fakeRequest({ origin: 'https://evil.example.com', host: 'app.example.com' })),
    ).toBe(false);
  });

  it('跨域但在白名单 → 放行', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://evil.example.com';
    expect(
      isOriginAllowed(fakeRequest({ origin: 'https://evil.example.com', host: 'app.example.com' })),
    ).toBe(true);
  });
});

describe('applyCorsHeaders', () => {
  it('白名单内的跨域请求回显 ACAO + credentials', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';
    const request = fakeRequest({ origin: 'https://app.example.com', host: 'api.example.com' });
    const response = new Response();
    applyCorsHeaders(request, response);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('同源请求不加 CORS 头', () => {
    const request = fakeRequest({ origin: 'http://app.example.com', host: 'app.example.com' });
    const response = new Response();
    applyCorsHeaders(request, response);
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
  });
});
