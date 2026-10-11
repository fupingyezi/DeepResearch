/**
 * 认证领域的类型装配：共享类型统一 re-export 自 @/types/auth（前端可见），
 * 领域映射函数（toUserResponse）留在此处。
 */

import type { UserRecord, UserResponse } from '@/types/auth';

export * from '@/types/auth';

export function toUserResponse(user: UserRecord): UserResponse {
  return {
    id: user.id,
    email: user.email,
    systemRole: user.systemRole,
    needsSetup: user.needsSetup,
    emailVerified: user.emailVerified,
  };
}
