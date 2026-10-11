/**
 * auth 域 HTTP 层逻辑（自 src/app/api/auth/**route.ts 整体抽出）。
 *
 * 各 handler 是裸函数：不感知 withApiHandler（鉴权 / body 解析 / 限流都在
 * route.ts 的 withApiHandler 选项里完成），输入即解析后的 ctx。route.ts
 * 已退化为薄适配器，只保留 withApiHandler 选项、Next 配置导出（dynamic /
 * runtime / OPTIONS），本文件是这些路由的唯一逻辑来源。
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  AuthErrorCode,
  adminExists,
  authenticate,
  // 与下方同名 handler（changePassword）冲突，别名引入
  changePassword as changeUserPassword,
  getDemoAccount,
  initializeAdmin,
  isRegistrationEnabled,
  registerUser,
  toUserResponse,
  validateStrongPassword,
} from '@/backend/auth';
import type { ApiRouteHandler } from '@/backend/http';
import {
  clearAuthCookies,
  createRateLimiter,
  jsonError,
  loginFailures,
  setAuthCookies,
} from '@/backend/http';
import { isMailConfigured } from '@/backend/lib/mailer';
import { EmailExistsError } from '@/backend/repositories/user';
import { getAuthService } from '@/backend/services/auth-service';
import {
  changePasswordSchema,
  credentialsSchema,
  emailTokenSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from '@/backend/validation/schemas';

/**
 * POST /api/auth/change-password —— 修改密码（可同时改邮箱）。
 *
 * 校验当前密码 → 更新 → 自增 token_version 使旧 token 失效 → 重新签发 cookie。
 */
export const changePassword: ApiRouteHandler<
  z.infer<typeof changePasswordSchema>,
  undefined
> = async ({ user, body }) => {
  const {
    current_password: currentPassword,
    new_password: newPassword,
    new_email: newEmail,
  } = body;

  const weak = validateStrongPassword(newPassword);
  if (weak) {
    return jsonError(AuthErrorCode.WEAK_PASSWORD, weak, 400);
  }

  const result = await changeUserPassword(user!.id, currentPassword, newPassword, newEmail);
  if (!result.ok || !result.user) {
    if (result.reason === 'email_taken') {
      return jsonError(AuthErrorCode.EMAIL_ALREADY_EXISTS, 'Email already in use', 400);
    }
    return jsonError(AuthErrorCode.INVALID_CREDENTIALS, 'Current password is incorrect', 400);
  }

  // 改密自增 tokenVersion 已使旧 token 全失效；重签新对让当前会话无缝续期
  const tokens = getAuthService().issueTokenPair(result.user);
  const response = NextResponse.json({ message: 'Password changed successfully' });
  setAuthCookies(response, tokens);
  return response;
};

/**
 * POST /api/auth/demo-login —— 体验账号一键登录。
 *
 * 凭证取自服务器环境变量（AUTH_DEMO_EMAIL / AUTH_DEMO_PASSWORD），不接收请求体，
 * 前端永远拿不到密码。未配置返回 404；凭证与库中账号不匹配返回 401
 * （多半是 env 与账号密码不同步，检查服务器 .env.production）。
 */
export const demoLogin: ApiRouteHandler<undefined, undefined> = async () => {
  const demo = getDemoAccount();
  if (!demo) {
    return jsonError(AuthErrorCode.INVALID_INPUT, 'Demo login is not enabled', 404);
  }

  const user = await authenticate(demo.email, demo.password);
  if (!user) {
    return jsonError(
      AuthErrorCode.INVALID_CREDENTIALS,
      'Demo account credentials are invalid',
      401,
    );
  }

  const tokens = getAuthService().issueTokenPair(user);
  const response = NextResponse.json(toUserResponse(user));
  setAuthCookies(response, tokens);
  return response;
};

/**
 * POST /api/auth/forgot-password —— 忘记密码：向注册邮箱发重置邮件。
 *
 * 防用户枚举：无论邮箱是否注册都返回同一句话（真实用户才发信）；
 * SMTP 未配置时 503（发不出信的提示不能泄露账号存在性）。
 */
export const forgotPassword: ApiRouteHandler<
  z.infer<typeof forgotPasswordSchema>,
  undefined
> = async ({ body }) => {
  if (!isMailConfigured()) {
    return jsonError('MAIL_NOT_CONFIGURED', 'Email service is not configured', 503);
  }
  await getAuthService().forgotPassword(body.email);
  return NextResponse.json({ message: '如果该邮箱已注册，重置邮件已发送' });
};

/**
 * POST /api/auth/initialize —— 首启创建第一个管理员。
 *
 * 仅当系统无 admin 时可调用；已存在返回 409。
 * 创建后把存量无归属会话回填给该 admin（provider.initializeAdmin 内完成）。
 */
export const initialize: ApiRouteHandler<z.infer<typeof credentialsSchema>, undefined> = async ({
  body,
}) => {
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
      return jsonError(AuthErrorCode.SYSTEM_ALREADY_INITIALIZED, 'System already initialized', 409);
    }
    throw e;
  }
};

/**
 * POST /api/auth/login —— 邮箱密码登录。
 *
 * 成功：签发 JWT 写入 HttpOnly cookie，返回 UserResponse。
 * 失败：401 INVALID_CREDENTIALS。
 */
export const login: ApiRouteHandler<z.infer<typeof credentialsSchema>, undefined> = async ({
  body,
}) => {
  if (await loginFailures.isLocked(body.email)) {
    return jsonError('LOGIN_LOCKED', 'Too many failed attempts, please try again later', 429);
  }

  const user = await authenticate(body.email, body.password);
  if (!user) {
    await loginFailures.record(body.email);
    return jsonError(AuthErrorCode.INVALID_CREDENTIALS, 'Incorrect email or password', 401);
  }

  await loginFailures.clear(body.email);
  const tokens = getAuthService().issueTokenPair(user);
  const response = NextResponse.json(toUserResponse(user));
  setAuthCookies(response, tokens);
  return response;
};

/**
 * POST /api/auth/logout —— 清除双 token cookie。
 *
 * 无状态设计下登出没有服务端吊销通道：清 cookie 即完成登出；已被拷贝出去的
 * token 至多活到各自过期（access ≤15min / refresh ≤7d）。全局失效走
 * users.token_version（改密 / 重置密码自增）。恒 200——登出永不失败。
 */
export const logout: ApiRouteHandler<undefined, undefined> = async () => {
  const response = NextResponse.json({ message: 'Successfully logged out' });
  clearAuthCookies(response);
  return response;
};

/**
 * GET /api/auth/me —— 返回当前登录用户信息，未登录返回 401。
 */
export const me: ApiRouteHandler<undefined, undefined> = async ({ user }) => {
  return NextResponse.json(toUserResponse(user!));
};

/**
 * POST /api/auth/register —— 注册普通用户（角色 user）并自动登录。
 *
 * admin 由首启 /api/auth/initialize 创建；此处只产生 user 角色账号。
 */
export const register: ApiRouteHandler<z.infer<typeof credentialsSchema>, undefined> = async ({
  body,
}) => {
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
      await getAuthService().sendVerificationEmail(user);
    }
    const tokens = getAuthService().issueTokenPair(user);
    const response = NextResponse.json(toUserResponse(user), { status: 201 });
    setAuthCookies(response, tokens);
    return response;
  } catch (e) {
    if (e instanceof EmailExistsError) {
      return jsonError(AuthErrorCode.EMAIL_ALREADY_EXISTS, 'Email already registered', 400);
    }
    throw e;
  }
};

/**
 * POST /api/auth/resend-verification —— 重发验证邮件（登录态）。
 *
 * 已验证用户直接 200（幂等）；SMTP 未配置时 503——此时注册即已验证，正常走不到这里。
 */
export const resendVerification: ApiRouteHandler<undefined, undefined> = async ({ user }) => {
  if (user!.emailVerified) {
    return NextResponse.json({ message: 'Email already verified' });
  }
  if (!isMailConfigured()) {
    return jsonError('MAIL_NOT_CONFIGURED', 'Email service is not configured', 503);
  }
  await getAuthService().sendVerificationEmail(user!);
  return NextResponse.json({ message: 'Verification email sent' });
};

/**
 * POST /api/auth/reset-password —— 用邮件令牌重置密码。
 *
 * 令牌核销成功才重置（单次使用，暴力猜测每次尝试都会消耗令牌本身）；
 * 重置自增 tokenVersion，该用户全部既有 JWT 失效。
 */
export const resetPassword: ApiRouteHandler<
  z.infer<typeof resetPasswordSchema>,
  undefined
> = async ({ body }) => {
  const weak = validateStrongPassword(body.new_password);
  if (weak) {
    return jsonError(AuthErrorCode.WEAK_PASSWORD, weak, 400);
  }

  const reset = await getAuthService().resetPassword(body.token, body.new_password);
  if (!reset) {
    return jsonError('INVALID_TOKEN', 'Invalid or expired token', 400);
  }

  return NextResponse.json({ message: 'Password reset successfully' });
};

/**
 * GET /api/auth/setup-status —— 是否需要首启设置（无 admin 时 needs_setup=true）。
 *
 * 顺带返回体验账号入口是否开启（凭证见 AUTH_DEMO_EMAIL / AUTH_DEMO_PASSWORD，
 * 只暴露 email 用于展示按钮文案，不含密码）。
 */
export const getSetupStatus: ApiRouteHandler<undefined, undefined> = async () => {
  const exists = await adminExists();
  const demo = getDemoAccount();
  return NextResponse.json({
    needs_setup: !exists,
    demo_login: { enabled: demo !== null, email: demo?.email ?? null },
    registration: { enabled: isRegistrationEnabled() },
  });
};

/**
 * POST /api/auth/verify-email —— 邮箱验证令牌核销。
 *
 * 令牌经 sha256 匹配、单次使用；幂等：已验证的用户重复提交有效令牌也返回 200；
 * 无效/过期令牌 400 INVALID_TOKEN。
 */
export const verifyEmail: ApiRouteHandler<z.infer<typeof emailTokenSchema>, undefined> = async ({
  body,
}) => {
  const verified = await getAuthService().verifyEmail(body.token);
  if (!verified) {
    return jsonError('INVALID_TOKEN', 'Invalid or expired token', 400);
  }
  return NextResponse.json({ message: 'Email verified' });
};

/** 本域路由的限流器（route.ts 的 withApiHandler 选项引用）。 */
export const authRateLimits = {
  changePassword: createRateLimiter({
    bucket: 'changePassword',
    max: 10,
    windowMs: 15 * 60_000,
  }),
  demoLogin: createRateLimiter({
    bucket: 'demoLogin',
    max: 10,
    windowMs: 15 * 60_000,
  }),
  forgotPassword: createRateLimiter({
    bucket: 'forgotPassword',
    max: 5,
    windowMs: 15 * 60_000,
  }),
  initialize: createRateLimiter({
    bucket: 'initialize',
    max: 5,
    windowMs: 15 * 60_000,
  }),
  // IP 维度兜底防爆破；账号维度失败锁定见 loginFailures（handler 内先判锁再验密码，
  // 锁定期内不消耗 bcrypt）
  login: createRateLimiter({ bucket: 'login', max: 20, windowMs: 15 * 60_000 }),
  // 注册是创建账号 + bcrypt 哈希的昂贵操作，IP 维度限流防批量注册
  register: createRateLimiter({ bucket: 'register', max: 10, windowMs: 3600_000 }),
  resendVerification: createRateLimiter({
    bucket: 'resendVerify',
    max: 5,
    windowMs: 15 * 60_000,
  }),
};

export const authController = {
  changePassword,
  demoLogin,
  forgotPassword,
  initialize,
  login,
  logout,
  me,
  register,
  resendVerification,
  resetPassword,
  getSetupStatus,
  verifyEmail,
};
