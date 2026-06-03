/**
 * GET /api/auth/oauth/[provider] —— OAuth 登录入口占位。
 *
 * 第三方 OAuth（github/google）尚未实现，返回 501。
 */

import { NextResponse } from 'next/server';

export async function GET(_request: Request, { params }: { params: { provider: string } }) {
  return NextResponse.json(
    { message: `OAuth login for '${params.provider}' is not implemented yet` },
    { status: 501 },
  );
}
