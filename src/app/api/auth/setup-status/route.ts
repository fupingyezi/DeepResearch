/**
 * GET /api/auth/setup-status —— 是否需要首启设置（无 admin 时 needs_setup=true）。
 *
 * 顺带返回体验账号入口是否开启（凭证见 AUTH_DEMO_EMAIL / AUTH_DEMO_PASSWORD，
 * 只暴露 email 用于展示按钮文案，不含密码）。
 */

import { NextResponse } from 'next/server';

import { adminExists, getDemoAccount } from '@deerflow-harness/auth';

// 每次实时查询 admin 是否存在，禁止静态预渲染缓存
export const dynamic = 'force-dynamic';

export async function GET() {
  const exists = await adminExists();
  const demo = getDemoAccount();
  return NextResponse.json({
    needs_setup: !exists,
    demo_login: { enabled: demo !== null, email: demo?.email ?? null },
  });
}
