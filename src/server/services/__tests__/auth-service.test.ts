import { beforeEach, describe, expect, it, vi } from 'vitest';

// 经 email-token dao / user-repository 导入链会拉到 @/lib/db（pg），测试里替换为桩
vi.mock('@/lib/db', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('@/lib/mailer', () => ({
  isMailConfigured: vi.fn(() => false),
  sendMail: vi.fn(),
}));

// 桶导出链会加载 provider（解构全部 6 个命名导出），mock 必须给齐
vi.mock('@deerflow-harness/auth/user-repository', () => ({
  backfillOrphanData: vi.fn(),
  countAdminUsers: vi.fn(),
  createUser: vi.fn(),
  getUserByEmail: vi.fn(),
  getUserById: vi.fn(),
  updateUser: vi.fn(),
}));

import { verifyAccessToken, verifyRefreshToken } from '@deerflow-harness/auth/jwt';
import type { UserRecord } from '@deerflow-harness/auth';
import { getUserByEmail, updateUser } from '@deerflow-harness/auth/user-repository';
import { sendMail } from '@/lib/mailer';
import type { EmailTokenStore } from '@/server/daos/email-token';

import { createAuthService } from '../auth-service';

const getUserByEmailMock = vi.mocked(getUserByEmail);
const updateUserMock = vi.mocked(updateUser);
const sendMailMock = vi.mocked(sendMail);

const user: UserRecord = {
  id: 'u1',
  email: 'u1@example.com',
  passwordHash: 'x',
  systemRole: 'user',
  needsSetup: false,
  emailVerified: false,
  tokenVersion: 3,
  createdAt: '',
  updatedAt: '',
};

function makeEmailTokenStore(overrides: Partial<EmailTokenStore> = {}): EmailTokenStore {
  return {
    issue: vi.fn().mockResolvedValue('token-1'),
    consume: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_JWT_SECRET = 'test-secret';
  delete process.env.AUTH_ACCESS_TOKEN_EXPIRES_MINUTES;
  delete process.env.AUTH_TOKEN_EXPIRY_DAYS;
});

describe('issueTokenPair', () => {
  it('签发无状态对：access/refresh 可验回同 sub/ver，jti 每次不同', () => {
    const service = createAuthService();
    const a = service.issueTokenPair(user);
    const b = service.issueTokenPair(user);

    const accessA = verifyAccessToken(a.accessToken);
    const refreshA = verifyRefreshToken(a.refreshToken);
    expect(accessA?.sub).toBe('u1');
    expect(accessA?.ver).toBe(3);
    expect(accessA?.typ).toBe('access');
    expect(refreshA?.sub).toBe('u1');
    expect(refreshA?.typ).toBe('refresh');
    expect(refreshA?.jti).toBeTruthy();

    const refreshB = verifyRefreshToken(b.refreshToken);
    expect(refreshB?.jti).not.toBe(refreshA?.jti);
  });
});

describe('邮箱令牌流', () => {
  it('verifyEmail：核销成功 → 置 email_verified 返回 true', async () => {
    const consume = vi.fn().mockResolvedValue('u1');
    const service = createAuthService({ emailTokenStore: makeEmailTokenStore({ consume }) });

    await expect(service.verifyEmail('token-1')).resolves.toBe(true);
    expect(consume).toHaveBeenCalledWith('token-1', 'verify_email');
    expect(updateUserMock).toHaveBeenCalledWith('u1', { emailVerified: true });
  });

  it('verifyEmail：令牌无效/过期 → false，不更新用户', async () => {
    const service = createAuthService({ emailTokenStore: makeEmailTokenStore() });

    await expect(service.verifyEmail('bad')).resolves.toBe(false);
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it('forgotPassword：真实用户才发信（响应防枚举由路由层保证）', async () => {
    getUserByEmailMock.mockResolvedValue(user);
    const issue = vi.fn().mockResolvedValue('reset-token');
    const service = createAuthService({ emailTokenStore: makeEmailTokenStore({ issue }) });

    await service.forgotPassword(' U1@EXAMPLE.COM ');
    expect(getUserByEmailMock).toHaveBeenCalledWith('u1@example.com');
    expect(issue).toHaveBeenCalledWith('u1', 'reset_password');
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it('forgotPassword：用户不存在 → 静默不发信', async () => {
    getUserByEmailMock.mockResolvedValue(null);
    const issue = vi.fn();
    const service = createAuthService({ emailTokenStore: makeEmailTokenStore({ issue }) });

    await service.forgotPassword('ghost@example.com');
    expect(issue).not.toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
