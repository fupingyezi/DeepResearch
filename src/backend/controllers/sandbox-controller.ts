/**
 * sandbox 域 HTTP 层逻辑（自 route.ts 抽出）；route.ts 是薄适配器。
 *
 * 覆盖 /api/sandbox/stats 的 handler 与 guard（route.ts 继续以它作 guard 选项）。
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { ApiRouteHandler } from '@/backend/http';
import { getSandboxStatsSnapshot } from '@/backend/services/sandbox-service';
import { sandboxStatsQuerySchema } from '@/backend/validation/schemas';

/**
 * GET /api/sandbox/stats —— 只读沙箱监控
 *
 * 返回多对话并行下的容器运行态：thread↔container↔lastActiveAt↔refCount 映射、
 * 空闲时长与（可选）docker stats 资源采样。仅 docker backend 有数据，local 返回空。
 *
 * 访问控制：这是跨租户运维数据，默认关闭。必须配置 DEERFLOW_SANDBOX_STATS_TOKEN
 * 并携带匹配的 `x-sandbox-stats-token` 请求头才能访问；未配置 token 时一律 401，
 * 避免误暴露（本地调试可临时设置任意 token 值）。
 * 不接受任何外部地址输入，仅读取本机 docker daemon，无 SSRF 面。
 *
 * 查询参数：
 * - stats=0 跳过 docker stats 采样（更快，仅看登记态）。
 */

// 纯函数 guard：只判 token，不伪造 UserRecord
export function isAuthorized(request: Request): boolean {
  const token = process.env.DEERFLOW_SANDBOX_STATS_TOKEN;
  // 未配置 token 时该接口禁用（fail-closed），避免运维数据默认暴露
  if (!token || token.trim().length === 0) return false;
  return request.headers.get('x-sandbox-stats-token') === token;
}

export const stats: ApiRouteHandler<undefined, z.infer<typeof sandboxStatsQuerySchema>> = async ({
  query,
}) => {
  const includeStats = query.stats !== '0';
  const snapshot = await getSandboxStatsSnapshot(includeStats);
  return NextResponse.json(snapshot, { status: 200 });
};
