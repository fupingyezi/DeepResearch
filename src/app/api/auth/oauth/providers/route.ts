/**
 * GET /api/auth/oauth/providers —— 下发已配置的 OAuth provider 列表。
 *
 * 登录页据此渲染第三方登录按钮：一个平台都未配置时返回空数组，按钮全部隐藏。
 * 静态段优先于同目录的 [provider] 动态段，路由无冲突。
 */
import { NextResponse } from 'next/server';

import { withApiHandler } from '@/server/http';
import { getOAuthService } from '@/server/services/oauth-service';

export { OPTIONS } from '@/server/http/preflight';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler({ auth: 'none' }, async () =>
  NextResponse.json({ providers: getOAuthService().listConfiguredProviders() }),
);
