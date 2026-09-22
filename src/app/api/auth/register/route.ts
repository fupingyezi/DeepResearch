/**
 * POST /api/auth/register —— 注册普通用户（角色 user）并自动登录。
 *
 * admin 由首启 /api/auth/initialize 创建；此处只产生 user 角色账号。
 */

import { NextResponse } from 'next/server';

import {
  AuthErrorCode,
  createAccessToken,
  registerUser,
  toUserResponse,
  validateStrongPassword,
} from '@deerflow-harness/auth';
import { EmailExistsError } from '@deerflow-harness/auth/user-repository';
import { jsonError, setSessionCookie, withApiHandler } from '@/server/http';
import { credentialsSchema } from '@/server/validation/schemas';

export const POST = withApiHandler({ auth: 'none', body: credentialsSchema }, async ({ body }) => {
  const { email, password } = body;

  const weak = validateStrongPassword(password);
  if (weak) {
    return jsonError(AuthErrorCode.WEAK_PASSWORD, weak, 400);
  }

  try {
    const user = await registerUser(email, password, 'user');
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
});
