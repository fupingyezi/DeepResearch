/**
 * Edge 网关中间件：仅做 cookie 存在性校验。
 *
 * 设计取舍：不在 Edge runtime 内做 jsonwebtoken 验签（Edge 对 Node crypto 支持
 * 受限），真正的验签与 token_version 校验放在各 API 路由的 getCurrentUser 内
 * （Node runtime）。本中间件只拦截"完全无 cookie"的访问，降低无效请求穿透。
 *
 * 放行（公开）：/api/auth/*、/login、/setup、Next 静态资源。
 * 受保护页面无 cookie → 重定向 /login；受保护 API 无 cookie → 401。
 */

import { NextRequest, NextResponse } from 'next/server';

const COOKIE_NAME = 'access_token';

const PUBLIC_PAGES = ['/login', '/setup'];

function isPublicPath(pathname: string): boolean {
  if (pathname.startsWith('/api/auth/')) return true;
  if (PUBLIC_PAGES.includes(pathname)) return true;
  return false;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const hasCookie = Boolean(request.cookies.get(COOKIE_NAME)?.value);
  if (hasCookie) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { code: 'UNAUTHENTICATED', message: 'Not authenticated' },
      { status: 401 },
    );
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/login';
  loginUrl.search = '';
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // 排除 Next 静态资源与 favicon；其余路径都过网关
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.svg$).*)'],
};
