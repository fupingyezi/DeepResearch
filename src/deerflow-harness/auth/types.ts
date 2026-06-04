/**
 * 用户系统的共享类型与错误码（前后端共用）。
 *
 * UserRecord 为后端内部完整表示（含 passwordHash / tokenVersion）；
 * UserResponse 为对外暴露给前端的安全子集（绝不含密码哈希）。
 */

export type SystemRole = 'admin' | 'user';

export interface UserRecord {
  id: string;
  email: string;
  /** bcrypt 哈希；OAuth 用户为 null */
  passwordHash: string | null;
  systemRole: SystemRole;
  /** 首启自动创建的 admin 在完成设置前为 true */
  needsSetup: boolean;
  /** 改密码时自增，使旧 JWT 失效 */
  tokenVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserResponse {
  id: string;
  email: string;
  systemRole: SystemRole;
  needsSetup: boolean;
}

/** 认证错误码，对外返回结构化错误，前端按 code 做文案映射 */
export enum AuthErrorCode {
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  EMAIL_ALREADY_EXISTS = 'EMAIL_ALREADY_EXISTS',
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  SYSTEM_ALREADY_INITIALIZED = 'SYSTEM_ALREADY_INITIALIZED',
  WEAK_PASSWORD = 'WEAK_PASSWORD',
  INVALID_INPUT = 'INVALID_INPUT',
}

export interface AuthErrorBody {
  code: AuthErrorCode;
  message: string;
}

export function toUserResponse(user: UserRecord): UserResponse {
  return {
    id: user.id,
    email: user.email,
    systemRole: user.systemRole,
    needsSetup: user.needsSetup,
  };
}
