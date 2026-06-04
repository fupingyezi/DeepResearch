/**
 * POST /api/auth/initialize —— 首启创建第一个管理员。
 *
 * 仅当系统无 admin 时可调用；已存在返回 409。
 * 创建后把存量无归属会话回填给该 admin（provider.initializeAdmin 内完成）。
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  AuthErrorCode,
  adminExists,
  createAccessToken,
  initializeAdmin,
  toUserResponse,
  validateStrongPassword,
} from '@deerflow-harness/auth';
import { EmailExistsError } from '@deerflow-harness/auth/user-repository';
import { jsonError, setSessionCookie } from '../_helpers';

interface InitializeBody {
  email?: unknown;
  password?: unknown;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as InitializeBody;
  const email = typeof body.email === 'string' ? body.email : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!email || !password) {
    return jsonError(AuthErrorCode.INVALID_INPUT, 'Email and password are required', 400);
  }

  const weak = validateStrongPassword(password);
  if (weak) {
    return jsonError(AuthErrorCode.WEAK_PASSWORD, weak, 400);
  }

  if (await adminExists()) {
    return jsonError(AuthErrorCode.SYSTEM_ALREADY_INITIALIZED, 'System already initialized', 409);
  }

  try {
    const admin = await initializeAdmin(email, password);
    const token = createAccessToken(admin.id, admin.tokenVersion);
    const response = NextResponse.json(toUserResponse(admin), { status: 201 });
    setSessionCookie(response, token);
    return response;
  } catch (e) {
    if (e instanceof EmailExistsError) {
      return jsonError(AuthErrorCode.SYSTEM_ALREADY_INITIALIZED, 'System already initialized', 409);
    }
    throw e;
  }
}
