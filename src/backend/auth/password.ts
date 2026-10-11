/**
 * 密码哈希工具（bcryptjs）。
 *
 * 注册/改密码用 hashPassword 生成哈希；登录用 verifyPassword 校验。
 * 强密码约束（最短 8 位 + 极小弱密码黑名单）在 validateStrongPassword 中，
 * 由 API 层在落库前调用。
 */

import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

const COMMON_PASSWORDS = new Set<string>([
  'password',
  'password1',
  'password123',
  '12345678',
  '123456789',
  'qwerty123',
  'iloveyou',
  'admin123',
  'welcome1',
]);

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * 校验密码强度，不通过则返回错误文案，通过返回 null。
 * 最短 8 位 + 大小写无关的弱密码黑名单。
 */
export function validateStrongPassword(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (COMMON_PASSWORDS.has(password.toLowerCase()))
    return 'Password is too common; choose a stronger password';
  return null;
}
