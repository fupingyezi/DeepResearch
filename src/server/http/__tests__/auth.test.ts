import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

import {
  createAccessToken,
  createRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '@deerflow-harness/auth/jwt';
import type { UserRecord } from '@deerflow-harness/auth';
import { getUserById } from '@deerflow-harness/auth/user-repository';

// 桶导出链（user-model-key-repository 等）会拉到 @/lib/db（pg），测试里替换为桩
vi.mock('@/lib/db', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
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

import { authenticateWithRefresh, clearAuthCookies, getCurrentUser, setAuthCookies } from '../auth';

const getUserByIdMock = vi.mocked(getUserById);

const SECRET = 'test-secret';

const user: UserRecord = {
  id: 'u1',
  email: 'u1@example.com',
  passwordHash: 'x',
  systemRole: 'user',
  needsSetup: false,
  emailVerified: true,
  tokenVersion: 1,
  createdAt: '',
  updatedAt: '',
};

function requestWithCookies(cookies: Record<string, string>): NextRequest {
  const cookie = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
  return new NextRequest('http://localhost/api/test', { headers: { cookie } });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_JWT_SECRET = SECRET;
  delete process.env.AUTH_ACCESS_TOKEN_EXPIRES_MINUTES;
  delete process.env.AUTH_TOKEN_EXPIRY_DAYS;
  getUserByIdMock.mockResolvedValue(user);
});

describe('authenticateWithRefresh', () => {
  it('access 有效 → 直接过，不刷新不产 token 对', async () => {
    const result = await authenticateWithRefresh(
      requestWithCookies({ access_token: createAccessToken('u1', 1) }),
    );
    expect(result.user?.id).toBe('u1');
    expect(result.tokens).toBeUndefined();
    expect(getUserByIdMock).toHaveBeenCalledTimes(1);
  });

  it('无 access + refresh 有效 → 刷新，新对可再验', async () => {
    const result = await authenticateWithRefresh(
      requestWithCookies({ refresh_token: createRefreshToken('u1', 1) }),
    );
    expect(result.user?.id).toBe('u1');
    expect(result.tokens).toBeDefined();
    expect(verifyAccessToken(result.tokens!.accessToken)?.sub).toBe('u1');
    expect(verifyRefreshToken(result.tokens!.refreshToken)?.sub).toBe('u1');
  });

  it('access 过期 + refresh 有效 → 透明刷新', async () => {
    const expiredAccess = jwt.sign({ sub: 'u1', ver: 1, typ: 'access' }, SECRET, {
      algorithm: 'HS256',
      expiresIn: '-1s' as `${number}s`,
    });
    const result = await authenticateWithRefresh(
      requestWithCookies({
        access_token: expiredAccess,
        refresh_token: createRefreshToken('u1', 1),
      }),
    );
    expect(result.user?.id).toBe('u1');
    expect(result.tokens).toBeDefined();
  });

  it('access 垃圾串 + refresh 有效 → 刷新（access 验签失败同样走 refresh）', async () => {
    const result = await authenticateWithRefresh(
      requestWithCookies({
        access_token: 'garbage',
        refresh_token: createRefreshToken('u1', 1),
      }),
    );
    expect(result.user?.id).toBe('u1');
    expect(result.tokens).toBeDefined();
  });

  it('refresh 过期 → null', async () => {
    const expiredRefresh = jwt.sign({ sub: 'u1', ver: 1, typ: 'refresh', jti: 'j1' }, SECRET, {
      algorithm: 'HS256',
      expiresIn: '-1s' as `${number}s`,
    });
    const result = await authenticateWithRefresh(
      requestWithCookies({ refresh_token: expiredRefresh }),
    );
    expect(result.user).toBeNull();
    expect(result.tokens).toBeUndefined();
  });

  it('refresh ver 落后（改密/重置后）→ null', async () => {
    getUserByIdMock.mockResolvedValue({ ...user, tokenVersion: 2 });
    const result = await authenticateWithRefresh(
      requestWithCookies({ refresh_token: createRefreshToken('u1', 1) }),
    );
    expect(result.user).toBeNull();
  });

  it('refresh sub 无对应用户 → null', async () => {
    getUserByIdMock.mockResolvedValue(null);
    const result = await authenticateWithRefresh(
      requestWithCookies({ refresh_token: createRefreshToken('ghost', 1) }),
    );
    expect(result.user).toBeNull();
  });

  it('access 型 token 塞 refresh cookie → null（typ 强制）', async () => {
    const result = await authenticateWithRefresh(
      requestWithCookies({ refresh_token: createAccessToken('u1', 1) }),
    );
    expect(result.user).toBeNull();
  });

  it('双 cookie 全无 → null，不查库', async () => {
    const result = await authenticateWithRefresh(requestWithCookies({}));
    expect(result.user).toBeNull();
    expect(getUserByIdMock).not.toHaveBeenCalled();
  });
});

describe('getCurrentUser', () => {
  it('access ver 落后 → null（改密后的旧 access 立即失效）', async () => {
    getUserByIdMock.mockResolvedValue({ ...user, tokenVersion: 2 });
    const result = await getCurrentUser(
      requestWithCookies({ access_token: createAccessToken('u1', 1) }),
    );
    expect(result).toBeNull();
  });
});

describe('cookie 写入', () => {
  it('setAuthCookies 在 plain Response 上追加双 Set-Cookie，属性与时长正确', () => {
    const response = new Response('ok');
    setAuthCookies(response, {
      accessToken: 'access-jwt',
      refreshToken: 'refresh-jwt',
    });
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    const [access, refresh] = cookies;
    expect(access).toBe(
      'access_token=access-jwt; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=900',
    );
    expect(refresh).toBe(
      'refresh_token=refresh-jwt; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=604800',
    );
  });

  it('env 覆盖 access 时长 → Max-Age 同步', () => {
    process.env.AUTH_ACCESS_TOKEN_EXPIRES_MINUTES = '30';
    const response = new Response('ok');
    setAuthCookies(response, { accessToken: 'a', refreshToken: 'r' });
    expect(response.headers.getSetCookie()[0]).toContain('Max-Age=1800');
  });

  it('clearAuthCookies 双 cookie 均 Max-Age=0', () => {
    const response = new Response('ok');
    clearAuthCookies(response);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain('access_token=;');
    expect(cookies[1]).toContain('refresh_token=;');
    expect(cookies.every((c) => c.includes('Max-Age=0'))).toBe(true);
  });
});
