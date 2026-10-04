/**
 * GET /api/health —— 就绪探针与降级可见性（多进程部署的 LB / 编排用）：
 * - distributed = 跨进程登记表与事件总线均可用（Redis 正常）。false 时整体
 *   退回单进程语义（跨进程取消 / 事件回放失效），仍可服务但应告警
 * - draining = 优雅停机中，503 让 LB 摘除本实例、不再派发新 run
 * 与 setup-status 分工：本路由是运行态就绪探针，setup-status 只做首启设置探测。
 */

import { NextResponse } from 'next/server';

import { withApiHandler } from '@/server/http';
import { getThreadService } from '@/server/wiring';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = withApiHandler({ auth: 'none' }, async () => {
  const svc = await getThreadService().catch(() => null);
  if (!svc) {
    // 服务初始化失败（DB 不可达等）：本实例不可用
    return NextResponse.json(
      { status: 'degraded', distributed: false, draining: false },
      { status: 503 },
    );
  }
  const health = svc.health();
  if (health.draining) {
    return NextResponse.json(
      { status: 'degraded', distributed: health.distributed, draining: true },
      { status: 503 },
    );
  }
  return NextResponse.json({
    status: health.distributed ? 'ok' : 'degraded',
    distributed: health.distributed,
    draining: false,
  });
});
