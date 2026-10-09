/**
 * CORS 与 Origin 白名单的单一出处（响应头 + CSRF 校验共用）。
 *
 * - applyCorsHeaders：响应侧。Origin 命中白名单才回 Access-Control-Allow-Origin
 *   （精确回显，禁通配——credentials 模式下浏览器拒绝 *）；同源请求无需 CORS 头。
 * - isOriginAllowed：请求侧（CSRF 用）。无 Origin = 非浏览器客户端，放行（鉴权在前）；
 *   同源恒允许；跨域必须命中白名单。
 */
import type { NextRequest } from 'next/server';

/** 预检允许的请求方法（与路由层实际提供的方法一致即可，保守全量） */
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
/** 预检允许的请求头：Content-Type 现在用，Authorization 为后续 API Token 预留 */
const ALLOWED_HEADERS = 'Content-Type, Authorization';
/** 预检结果浏览器缓存 24h，减少往返 */
const PREFLIGHT_MAX_AGE = '86400';

let cached: { raw: string; allowed: Set<string> } | null = null;

/** CORS_ALLOWED_ORIGINS（逗号分隔精确 origin）。空 = 仅同源。 */
export function getAllowedOrigins(): Set<string> {
  const raw = process.env.CORS_ALLOWED_ORIGINS ?? '';

  if (cached && cached.raw === raw) return cached.allowed;
  const allowed = new Set(
    raw
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  );

  if (allowed.has('*')) {
    console.warn('[cors] CORS_ALLOWED_ORIGINS 忽略通配 *：credentials 模式下浏览器会拒绝');
    allowed.delete('*');
  }

  cached = { raw, allowed };
  return allowed;
}

export function isOriginAllowed(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  if (origin === request.nextUrl.origin) return true;
  return getAllowedOrigins().has(origin);
}

export function applyCorsHeaders(
  request: NextRequest,
  response: Response,
  preflight = false,
): void {
  const origin = request.headers.get('origin');
  if (!origin || origin === request.nextUrl.origin) return;
  if (!getAllowedOrigins().has(origin)) return;

  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Credentials', 'true');
  response.headers.set('Vary', 'Origin'); // 响应随 Origin 变化，缓存键需含它
  if (preflight) {
    response.headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
    response.headers.set('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    response.headers.set('Access-Control-Max-Age', PREFLIGHT_MAX_AGE);
  }
}
