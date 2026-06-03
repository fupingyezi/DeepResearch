/**
 * 认证业务编排层。
 *
 * 组合 password + user-repository，提供登录校验、注册、首启建 admin（含存量回填）、
 * 改密码/邮箱（自增 tokenVersion 使旧 token 失效）等高层操作。
 * 邮箱统一小写归一，避免大小写导致的重复账号。
 */

import { hashPassword, verifyPassword } from './password';
import {
  backfillOrphanData,
  countAdminUsers,
  createUser,
  getUserByEmail,
  getUserById,
  updateUser,
} from './user-repository';
import type { SystemRole, UserRecord } from './types';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function authenticate(email: string, password: string): Promise<UserRecord | null> {
  const user = await getUserByEmail(normalizeEmail(email));
  if (!user || !user.passwordHash) return null;
  const ok = await verifyPassword(password, user.passwordHash);
  return ok ? user : null;
}

export async function registerUser(
  email: string,
  password: string,
  systemRole: SystemRole = 'user',
): Promise<UserRecord> {
  const passwordHash = await hashPassword(password);
  return createUser({ email: normalizeEmail(email), passwordHash, systemRole, needsSetup: false });
}

export async function adminExists(): Promise<boolean> {
  return (await countAdminUsers()) > 0;
}

/**
 * 首启创建管理员，并把存量无归属数据回填给该 admin。
 * 调用方需先确保无 admin 存在（initialize 路由内做 count 校验）。
 */
export async function initializeAdmin(email: string, password: string): Promise<UserRecord> {
  const passwordHash = await hashPassword(password);
  const admin = await createUser({
    email: normalizeEmail(email),
    passwordHash,
    systemRole: 'admin',
    needsSetup: false,
  });
  await backfillOrphanData(admin.id);
  return admin;
}

export interface ChangePasswordResult {
  ok: boolean;
  user?: UserRecord;
  /** ok=false 时的错误语义：'wrong_password' | 'email_taken' */
  reason?: 'wrong_password' | 'email_taken';
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  newEmail?: string,
): Promise<ChangePasswordResult> {
  const user = await getUserById(userId);
  if (!user || !user.passwordHash) return { ok: false, reason: 'wrong_password' };

  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) return { ok: false, reason: 'wrong_password' };

  if (newEmail) {
    const normalized = normalizeEmail(newEmail);
    const existing = await getUserByEmail(normalized);
    if (existing && existing.id !== user.id) return { ok: false, reason: 'email_taken' };
  }

  const passwordHash = await hashPassword(newPassword);
  const updated = await updateUser(userId, {
    passwordHash,
    tokenVersion: user.tokenVersion + 1,
    ...(newEmail ? { email: normalizeEmail(newEmail) } : {}),
  });
  return { ok: true, user: updated };
}

export { getUserById };
