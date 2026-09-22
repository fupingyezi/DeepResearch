/**
 * 限流钩子（占位，当前无实现）。
 *
 * 接口已定型：钩子返回非 null Response 即短路请求（withApiHandler 的 rateLimit 槽）。
 * 真正实现时需要跨进程计数（StreamBridge 同样受多实例部署约束），Redis 客户端已在
 * 依赖中就绪，届时在此实现固定窗口/令牌桶 + Redis 计数，路由层零改动。
 */

import type { NextRequest, NextResponse } from 'next/server';

export type RateLimitHook = (
  request: NextRequest,
) => NextResponse | null | Promise<NextResponse | null>;

export const noopRateLimit: RateLimitHook = () => null;
