/**
 * POST /api/auth/verify-email —— 邮箱验证令牌核销。
 *
 * 令牌经 sha256 匹配、单次使用；幂等：已验证的用户重复提交有效令牌也返回 200；
 * 无效/过期令牌 400 INVALID_TOKEN。
 */

import { NextResponse } from 'next/server';

import { jsonError, withApiHandler } from '@/server/http';
import { getAuthService } from '@/server/services/auth-service';
import { emailTokenSchema } from '@/server/validation/schemas';

export { OPTIONS } from '@/server/http/preflight';

export const POST = withApiHandler({ auth: 'none', body: emailTokenSchema }, async ({ body }) => {
  const verified = await getAuthService().verifyEmail(body.token);
  if (!verified) {
    return jsonError('INVALID_TOKEN', 'Invalid or expired token', 400);
  }
  return NextResponse.json({ message: 'Email verified' });
});
