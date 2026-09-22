/**
 * GET /api/auth/oauth/[provider] —— OAuth 登录入口占位。
 *
 * 第三方 OAuth（github/google）尚未实现，返回 501。
 */

import { jsonError, withApiHandler } from '@/server/http';

export const GET = withApiHandler({ auth: 'none' }, async ({ params }) => {
  return jsonError(
    'NOT_IMPLEMENTED',
    `OAuth login for '${params.provider}' is not implemented yet`,
    501,
  );
});
