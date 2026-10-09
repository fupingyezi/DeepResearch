/**
 * POST /api/auth/register —— 注册普通用户（角色 user）并自动登录。
 *
 * admin 由首启 /api/auth/initialize 创建；此处只产生 user 角色账号。
 */

import { NextResponse } from 'next/server';

import {
  AuthErrorCode,
  createAccessToken,
  isRegistrationEnabled,
  registerUser,
  toUserResponse,
  validateStrongPassword,
} from '@deerflow-harness/auth';
import { sendVerificationEmail } from '@deerflow-harness/auth/email-flow';
import { EmailExistsError } from '@deerflow-harness/auth/user-repository';
import { isMailConfigured } from '@/lib/mailer';
import { jsonError, setSessionCookie, withApiHandler } from '@/server/http';
import { createRateLimiter } from '@/server/http/rate-limit';
import { credentialsSchema } from '@/server/validation/schemas';

export { OPTIONS } from '@/server/http/preflight';

// 注册是创建账号 + bcrypt 哈希的昂贵操作，IP 维度限流防批量注册
const registerRateLimit = createRateLimiter({ bucket: 'register', max: 10, windowMs: 3600_000 });

export const POST = withApiHandler(
  { auth: 'none', body: credentialsSchema, rateLimit: registerRateLimit },
  async ({ body }) => {
    const { email, password } = body;

    if (!isRegistrationEnabled()) {
      return jsonError('REGISTRATION_DISABLED', 'Registration is currently disabled', 403);
    }

    const weak = validateStrongPassword(password);
    if (weak) {
      return jsonError(AuthErrorCode.WEAK_PASSWORD, weak, 400);
    }

    try {
      // SMTP 未配置时直接置已验证（发信功能缺失不阻断注册）；
      // 配置了则发验证邮件，用户先以未验证状态登录，前端提示补验
      const emailVerified = !isMailConfigured();
      const user = await registerUser(email, password, 'user', { emailVerified });
      if (!emailVerified) {
        await sendVerificationEmail(user);
      }
      const token = createAccessToken(user.id, user.tokenVersion);
      const response = NextResponse.json(toUserResponse(user), { status: 201 });
      setSessionCookie(response, token);
      return response;
    } catch (e) {
      if (e instanceof EmailExistsError) {
        return jsonError(AuthErrorCode.EMAIL_ALREADY_EXISTS, 'Email already registered', 400);
      }
      throw e;
    }
  },
);
