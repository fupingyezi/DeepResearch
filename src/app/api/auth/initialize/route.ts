/**
 * POST /api/auth/initialize —— 首启创建第一个管理员。
 *
 * 仅当系统无 admin 时可调用；已存在返回 409。
 * 创建后把存量无归属会话回填给该 admin（provider.initializeAdmin 内完成）。
 */

import { NextResponse } from 'next/server';

import {
  AuthErrorCode,
  adminExists,
  initializeAdmin,
  toUserResponse,
  validateStrongPassword,
} from '@deerflow-harness/auth';
import { EmailExistsError } from '@deerflow-harness/auth/user-repository';
import { jsonError, setAuthCookies, withApiHandler } from '@/server/http';
import { createRateLimiter } from '@/server/http/rate-limit';
import { getAuthService } from '@/server/services/auth-service';
import { credentialsSchema } from '@/server/validation/schemas';

export { OPTIONS } from '@/server/http/preflight';

const initializeRateLimit = createRateLimiter({
  bucket: 'initialize',
  max: 5,
  windowMs: 15 * 60_000,
});

export const POST = withApiHandler(
  { auth: 'none', body: credentialsSchema, rateLimit: initializeRateLimit },
  async ({ body }) => {
    const { email, password } = body;

    const weak = validateStrongPassword(password);
    if (weak) {
      return jsonError(AuthErrorCode.WEAK_PASSWORD, weak, 400);
    }

    if (await adminExists()) {
      return jsonError(AuthErrorCode.SYSTEM_ALREADY_INITIALIZED, 'System already initialized', 409);
    }

    try {
      const admin = await initializeAdmin(email, password);
      const tokens = getAuthService().issueTokenPair(admin);
      const response = NextResponse.json(toUserResponse(admin), { status: 201 });
      setAuthCookies(response, tokens);
      return response;
    } catch (e) {
      if (e instanceof EmailExistsError) {
        return jsonError(
          AuthErrorCode.SYSTEM_ALREADY_INITIALIZED,
          'System already initialized',
          409,
        );
      }
      throw e;
    }
  },
);
