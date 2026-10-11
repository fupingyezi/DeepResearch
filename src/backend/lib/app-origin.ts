/**
 * app 域 / OAuth 回调基址 / 请求外部 origin 的单一出处（邮件链接、OAuth 302 与
 * CORS/CSRF 同源判定共用）。
 *
 * - appBaseUrl()：发往浏览器的链接基址（验证邮件、OAuth 完成后的回跳目标）。
 * - callbackBaseUrl()：OAuth redirect_uri 基址——即第三方平台能回跳到的 **API 域**。
 *   前后端分离部署时两者不同：回调必须落到 api 域（callback 路由在那里），
 *   所以 callback 的回落链多一级 OAUTH_BASE_URL，且末级回落请求自身 origin。
 * - requestExternalOrigin()：请求的浏览器视角 origin（Host 头 + 协议还原）。
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
  if (!source) return requestExternalOrigin(request) ?? '';
  return source.replace(/\/+$/, '');
}

/**
 * 请求的外部 origin（浏览器看到的地址）：x-forwarded-proto + Host 头还原。
 * 不能用 request.nextUrl.origin 做同源比对——standalone 自托管下 Next 用绑定地址
 * （0.0.0.0 / 容器主机名）而非 Host 头重建 nextUrl，生产上比对恒失败
 * （dev 绑定 localhost 恰好掩盖）。缺 Host 返回 null（调用方自行回落）。
 */
export function requestExternalOrigin(request: NextRequest): string | null {
  const host = request.headers.get('host');
  if (!host) return null;
  const proto = (request.headers.get('x-forwarded-proto') ?? '').split(',')[0].trim();
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

export function oauthRedirectUri(request: NextRequest, provider: string): string {
  return `${callbackBaseUrl(request)}/api/auth/oauth/${provider}/callback`;
}
