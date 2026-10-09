import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import { appBaseUrl, callbackBaseUrl, oauthRedirectUri } from '../app-origin';

function fakeRequest(origin = 'http://localhost:3000') {
  return { nextUrl: { origin } } as unknown as NextRequest;
}

const ENV_KEYS = ['APP_BASE_URL', 'CORS_ALLOWED_ORIGINS', 'OAUTH_BASE_URL'] as const;

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

beforeEach(() => {
  clearEnv();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  clearEnv();
  vi.restoreAllMocks();
});

describe('appBaseUrl', () => {
  it('APP_BASE_URL 优先，去尾斜杠', () => {
    process.env.APP_BASE_URL = 'https://app.example.com/';
    process.env.CORS_ALLOWED_ORIGINS = 'https://cors.example.com';
    expect(appBaseUrl()).toBe('https://app.example.com');
  });

  it('回落 CORS 白名单第一项', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://a.example.com, https://b.example.com';
    expect(appBaseUrl()).toBe('https://a.example.com');
  });

  it('全未配置 → 空串 + 告警', () => {
    expect(appBaseUrl()).toBe('');
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('callbackBaseUrl', () => {
  it('OAUTH_BASE_URL 优先（跨域部署的 api 域）', () => {
    process.env.OAUTH_BASE_URL = 'https://api.example.com/';
    process.env.APP_BASE_URL = 'https://app.example.com';
    expect(callbackBaseUrl(fakeRequest())).toBe('https://api.example.com');
  });

  it('回落 APP_BASE_URL，再回落 CORS 白名单第一项', () => {
    process.env.APP_BASE_URL = 'https://app.example.com';
    expect(callbackBaseUrl(fakeRequest())).toBe('https://app.example.com');

    delete process.env.APP_BASE_URL;
    process.env.CORS_ALLOWED_ORIGINS = 'https://cors.example.com';
    expect(callbackBaseUrl(fakeRequest())).toBe('https://cors.example.com');
  });

  it('全未配置 → 请求自身 origin（同源部署）', () => {
    expect(callbackBaseUrl(fakeRequest('http://localhost:3000'))).toBe('http://localhost:3000');
  });
});

describe('oauthRedirectUri', () => {
  it('拼接 callback 路径', () => {
    process.env.OAUTH_BASE_URL = 'https://api.example.com';
    expect(oauthRedirectUri(fakeRequest(), 'github')).toBe(
      'https://api.example.com/api/auth/oauth/github/callback',
    );
  });
});
