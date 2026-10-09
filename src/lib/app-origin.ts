/**
 * app 域 / OAuth 回调基址的单一出处（邮件链接与 OAuth 302 共用）。
 *
 * - appBaseUrl()：发往浏览器的链接基址（验证邮件、OAuth 完成后的回跳目标）。
 * - callbackBaseUrl()：OAuth redirect_uri 基址——即第三方平台能回跳到的 **API 域**。
 *   前后端分离部署时两者不同：回调必须落到 api 域（callback 路由在那里），
 *   所以 callback 的回落链多一级 OAUTH_BASE_URL，且末级回落请求自身 origin。
 */
import type { NextRequest } from 'next/server';

/** CORS 白名单第一项（与 CORS_ALLOWED_ORIGINS 解析一致，空返回空串） */
function firstCorsOrigin(): string {
  return process.env.CORS_ALLOWED_ORIGINS?.split(',')[0]?.trim() ?? '';
}

export function appBaseUrl(): string {
  const source = process.env.APP_BASE_URL?.trim() || firstCorsOrigin();
  if (!source) {
    console.warn('[app-origin] APP_BASE_URL 未配置，邮件链接/OAuth 回跳将回落相对路径');
    return '';
  }
  return source.replace(/\/+$/, '');
}

export function callbackBaseUrl(request: NextRequest): string {
  const source =
    process.env.OAUTH_BASE_URL?.trim() || process.env.APP_BASE_URL?.trim() || firstCorsOrigin();
  if (!source) return request.nextUrl.origin;
  return source.replace(/\/+$/, '');
}

export function oauthRedirectUri(request: NextRequest, provider: string): string {
  return `${callbackBaseUrl(request)}/api/auth/oauth/${provider}/callback`;
}
