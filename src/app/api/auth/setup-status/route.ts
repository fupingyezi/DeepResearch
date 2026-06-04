/**
 * GET /api/auth/setup-status —— 是否需要首启设置（无 admin 时 needs_setup=true）。
 */

import { NextResponse } from 'next/server';

import { adminExists } from '@deerflow-harness/auth';

// 每次实时查询 admin 是否存在，禁止静态预渲染缓存
export const dynamic = 'force-dynamic';

export async function GET() {
  const exists = await adminExists();
  return NextResponse.json({ needs_setup: !exists });
}
