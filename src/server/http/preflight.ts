/**
 * 跨域预检的共享 OPTIONS handler：浏览器对非简单跨域请求先发 OPTIONS（不带
 * cookie），由本 handler 直接回 204 + 预检头，不经过鉴权管线。
 * 各会被跨域调用的路由加一行 `export { OPTIONS } from '@/server/http/preflight';`。
 */
import type { NextRequest } from 'next/server';

import { applyCorsHeaders } from './cors';

export async function OPTIONS(request: NextRequest) {
  const response = new Response(null, { status: 204 });
  applyCorsHeaders(request, response, true);

  return response;
}
