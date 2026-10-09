import { beforeEach, describe, expect, it, vi } from 'vitest';

// 经 dao 导入链会拉到 @/lib/db（pg），测试里替换为桩
vi.mock('@/lib/db', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('@deerflow-harness/auth/user-repository', () => ({
  createUser: vi.fn(),
  getUserByEmail: vi.fn(),
  getUserById: vi.fn(),
  EmailExistsError: class EmailExistsError extends Error {
    code = 'EMAIL_EXISTS';
    constructor() {
      super('Email already exists');
    }
  },
}));

import type { UserRecord } from '@deerflow-harness/auth';
import {
  EmailExistsError,
  createUser,
  getUserByEmail,
  getUserById,
} from '@deerflow-harness/auth/user-repository';
import type { OAuthProviderAdapter, OAuthProviderName, OAuthUserInfo } from '@/lib/oauth';
import { OAuthAdapterError } from '@/lib/oauth';
import {
  OAuthAccountExistsError,
  type OAuthAccountRecord,
  type OAuthAccountStore,
} from '@/server/daos/oauth-account';
import { createOAuthService } from '../oauth-service';

const createUserMock = vi.mocked(createUser);
const getUserByEmailMock = vi.mocked(getUserByEmail);
const getUserByIdMock = vi.mocked(getUserById);

function makeUser(id: string): UserRecord {
  return {
    id,
    email: `${id}@test.local`,
    passwordHash: null,
    systemRole: 'user',
    needsSetup: false,
    emailVerified: true,
    tokenVersion: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeInfo(overrides: Partial<OAuthUserInfo> = {}): OAuthUserInfo {
  return {
    providerUserId: 'gh-123',
    email: 'gh-user@test.local',
    emailVerified: true,
    displayName: 'GH User',
    ...overrides,
  };
}

function makeAdapter(overrides: Partial<OAuthProviderAdapter> = {}): OAuthProviderAdapter {
  return {
    name: 'github',
    isConfigured: vi.fn(() => true),
    buildAuthorizeUrl: vi.fn(
      (state: string, redirectUri: string) =>
        `https://github.com/authorize?state=${state}&redirect_uri=${redirectUri}`,
    ),
    exchange: vi.fn(async () => makeInfo()),
    ...overrides,
  } as OAuthProviderAdapter;
}

interface FakeAccountStore {
  findByProvider: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
}

function makeAccountStore(): FakeAccountStore {
  return {
    findByProvider: vi.fn(async () => null),
    create: vi.fn(
      async (
        userId: string,
        provider: OAuthProviderName,
        providerUserId: string,
      ): Promise<OAuthAccountRecord> => ({
        id: 'b1',
        userId,
        provider,
        providerUserId,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ),
  };
}

const REDIRECT_URI = 'http://localhost:3000/api/auth/oauth/github/callback';
const VALID_STATE = 'a'.repeat(64);

function makeService(accounts: FakeAccountStore, adapters: OAuthProviderAdapter[]) {
  return createOAuthService({
    oauthAccounts: accounts as unknown as OAuthAccountStore,
    adapters,
  });
}

beforeEach(() => {
  createUserMock.mockReset();
  getUserByEmailMock.mockReset();
  getUserByIdMock.mockReset();
});

describe('handleCallback 绑定决策树', () => {
  it('绑定命中 → 直接登录，不建号不查邮箱', async () => {
    const accounts = makeAccountStore();
    accounts.findByProvider.mockResolvedValue({ userId: 'u1' } as OAuthAccountRecord);
    getUserByIdMock.mockResolvedValue(makeUser('u1'));

    const service = makeService(accounts, [makeAdapter()]);
    const user = await service.handleCallback(
      'github',
      'code',
      VALID_STATE,
      VALID_STATE,
      REDIRECT_URI,
    );

    expect(user.id).toBe('u1');
    expect(getUserByEmailMock).not.toHaveBeenCalled();
    expect(createUserMock).not.toHaveBeenCalled();
    expect(accounts.create).not.toHaveBeenCalled();
  });

  it('绑定未命中 + 邮箱未占用 → 建号（passwordHash null）并写绑定行；邮箱归一化', async () => {
    const accounts = makeAccountStore();
    const adapter = makeAdapter({
      exchange: vi.fn(async () => makeInfo({ email: '  Gh-User@Test.Local ' })),
    });
    createUserMock.mockResolvedValue(makeUser('u-new'));

    const service = makeService(accounts, [adapter]);
    const user = await service.handleCallback(
      'github',
      'code',
      VALID_STATE,
      VALID_STATE,
      REDIRECT_URI,
    );

    expect(user.id).toBe('u-new');
    expect(createUserMock).toHaveBeenCalledWith({
      email: 'gh-user@test.local',
      passwordHash: null,
      systemRole: 'user',
      needsSetup: false,
      emailVerified: true,
    });
    expect(accounts.create).toHaveBeenCalledWith('u-new', 'github', 'gh-123');
  });

  it('绑定未命中 + 邮箱撞本地账号 → EMAIL_TAKEN，什么都不建', async () => {
    const accounts = makeAccountStore();
    getUserByEmailMock.mockResolvedValue(makeUser('local-user'));

    const service = makeService(accounts, [makeAdapter()]);
    await expect(
      service.handleCallback('github', 'code', VALID_STATE, VALID_STATE, REDIRECT_URI),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' });

    expect(createUserMock).not.toHaveBeenCalled();
    expect(accounts.create).not.toHaveBeenCalled();
  });

  it('建号吃 EmailExistsError（并发竞态）→ EMAIL_TAKEN', async () => {
    const accounts = makeAccountStore();
    createUserMock.mockRejectedValue(new EmailExistsError());

    const service = makeService(accounts, [makeAdapter()]);
    await expect(
      service.handleCallback('github', 'code', VALID_STATE, VALID_STATE, REDIRECT_URI),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
  });

  it('写绑定吃唯一冲突 → 回查现有绑定登录（并发回调防御分支）', async () => {
    const accounts = makeAccountStore();
    accounts.create.mockRejectedValue(new OAuthAccountExistsError());
    accounts.findByProvider.mockResolvedValue({ userId: 'u-bound' } as OAuthAccountRecord);
    getUserByIdMock.mockResolvedValue(makeUser('u-bound'));

    const service = makeService(accounts, [makeAdapter()]);
    const user = await service.handleCallback(
      'github',
      'code',
      VALID_STATE,
      VALID_STATE,
      REDIRECT_URI,
    );

    expect(user.id).toBe('u-bound');
  });

  it('绑定行指向不存在的用户 → EXCHANGE_FAILED（数据异常不崩溃）', async () => {
    const accounts = makeAccountStore();
    accounts.findByProvider.mockResolvedValue({ userId: 'u-ghost' } as OAuthAccountRecord);
    getUserByIdMock.mockResolvedValue(null);

    const service = makeService(accounts, [makeAdapter()]);
    await expect(
      service.handleCallback('github', 'code', VALID_STATE, VALID_STATE, REDIRECT_URI),
    ).rejects.toMatchObject({ code: 'EXCHANGE_FAILED' });
  });
});

describe('handleCallback 前置校验与交换', () => {
  it('state 缺失/不匹配 → STATE_MISMATCH，且不消耗 code 交换', async () => {
    const accounts = makeAccountStore();
    const adapter = makeAdapter();

    const service = makeService(accounts, [adapter]);
    for (const [state, cookieState] of [
      [null, VALID_STATE],
      [VALID_STATE, null],
      [VALID_STATE, 'b'.repeat(64)],
      ['short', 'short-other'], // 长度不等路径
    ] as const) {
      await expect(
        service.handleCallback('github', 'code', state, cookieState, REDIRECT_URI),
      ).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    }
    expect(adapter.exchange).not.toHaveBeenCalled();
  });

  it('未知 provider 与未配置 provider 同归 PROVIDER_DISABLED', async () => {
    const accounts = makeAccountStore();
    const disabled = makeAdapter({ name: 'google', isConfigured: vi.fn(() => false) });

    const service = makeService(accounts, [disabled]);
    await expect(
      service.handleCallback('google', 'code', VALID_STATE, VALID_STATE, REDIRECT_URI),
    ).rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
    await expect(
      service.handleCallback('facebook', 'code', VALID_STATE, VALID_STATE, REDIRECT_URI),
    ).rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
  });

  it('exchange 抛 OAuthAdapterError → EXCHANGE_FAILED', async () => {
    const accounts = makeAccountStore();
    const adapter = makeAdapter({
      exchange: vi.fn(async () => {
        throw new OAuthAdapterError('github', 'token', '401: bad_verification_code');
      }),
    });

    const service = makeService(accounts, [adapter]);
    await expect(
      service.handleCallback('github', 'code', VALID_STATE, VALID_STATE, REDIRECT_URI),
    ).rejects.toMatchObject({ code: 'EXCHANGE_FAILED' });
  });

  it('exchange 抛非 adapter 错误 → 原样上抛', async () => {
    const accounts = makeAccountStore();
    const boom = new Error('boom');
    const adapter = makeAdapter({
      exchange: vi.fn(async () => {
        throw boom;
      }),
    });

    const service = makeService(accounts, [adapter]);
    await expect(
      service.handleCallback('github', 'code', VALID_STATE, VALID_STATE, REDIRECT_URI),
    ).rejects.toBe(boom);
  });

  it('平台无邮箱 → NO_EMAIL', async () => {
    const accounts = makeAccountStore();
    const adapter = makeAdapter({ exchange: vi.fn(async () => makeInfo({ email: null })) });

    const service = makeService(accounts, [adapter]);
    await expect(
      service.handleCallback('github', 'code', VALID_STATE, VALID_STATE, REDIRECT_URI),
    ).rejects.toMatchObject({ code: 'NO_EMAIL' });
  });
});

describe('begin 与 provider 列表', () => {
  it('begin 生成 64 位 hex state 并拼 authorize URL', () => {
    const adapter = makeAdapter();
    const service = makeService(makeAccountStore(), [adapter]);

    const { redirectUrl, state } = service.begin('github', REDIRECT_URI);
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(redirectUrl).toContain(`state=${state}`);
    expect(adapter.buildAuthorizeUrl).toHaveBeenCalledWith(state, REDIRECT_URI);
  });

  it('begin 未配置 provider → PROVIDER_DISABLED', () => {
    const service = makeService(makeAccountStore(), [
      makeAdapter({ isConfigured: vi.fn(() => false) }),
    ]);
    try {
      service.begin('github', REDIRECT_URI);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({ code: 'PROVIDER_DISABLED' });
    }
  });

  it('listConfiguredProviders 只列已配置且保持注册表序', () => {
    const service = makeService(makeAccountStore(), [
      makeAdapter({ name: 'github' }),
      makeAdapter({ name: 'google', isConfigured: vi.fn(() => false) }),
      makeAdapter({ name: 'qq' }),
    ]);
    expect(service.listConfiguredProviders()).toEqual(['github', 'qq']);
  });
});
