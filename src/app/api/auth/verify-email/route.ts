/**
 * POST /api/auth/verify-email —— 邮箱验证令牌核销。
 *
 * 令牌经 sha256 匹配、单次使用（email-tokens.consumeEmailToken）。
 * 幂等：已验证的用户重复提交有效令牌也返回 200；无效/过期令牌 400 INVALID_TOKEN。
 */

import { NextResponse } from 'next/server';

import { consumeEmailToken } from '@deerflow-harness/auth/email-tokens';
import { updateUser } from '@deerflow-harness/auth/user-repository';
import { jsonError, withApiHandler } from '@/server/http';
import { emailTokenSchema } from '@/server/validation/schemas';

export { OPTIONS } from '@/server/http/preflight';

export const POST = withApiHandler({ auth: 'none', body: emailTokenSchema }, async ({ body }) => {
  const userId = await consumeEmailToken(body.token, 'verify_email');
  if (!userId) {
    return jsonError('INVALID_TOKEN', 'Invalid or expired token', 400);
  }
  await updateUser(userId, { emailVerified: true });
  return NextResponse.json({ message: 'Email verified' });
});
