import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));

import { query } from '@/lib/db';
import { OAuthAccountExistsError, PgOAuthAccountStore } from '../postgres-store';

const queryMock = vi.mocked(query);

const ROW = {
  id: 'b1',
  user_id: 'u1',
  provider: 'github',
  provider_user_id: 'gh-1',
  created_at: new Date('2026-01-01T00:00:00.000Z'),
};

describe('PgOAuthAccountStore', () => {
  it('findByProvider：按 (provider, provider_user_id) 查询并映射', async () => {
    queryMock.mockResolvedValue({ rows: [ROW], rowCount: 1 } as never);

    const record = await new PgOAuthAccountStore().findByProvider('github', 'gh-1');

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('provider = $1 and provider_user_id = $2'),
      ['github', 'gh-1'],
    );
    expect(record).toEqual({
      id: 'b1',
      userId: 'u1',
      provider: 'github',
      providerUserId: 'gh-1',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('findByProvider 未命中 → null', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 } as never);
    expect(await new PgOAuthAccountStore().findByProvider('github', 'nope')).toBeNull();
  });

  it('create：插入并返回记录', async () => {
    queryMock.mockResolvedValue({ rows: [ROW], rowCount: 1 } as never);

    const record = await new PgOAuthAccountStore().create('u1', 'github', 'gh-1');

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('insert into oauth_accounts'),
      expect.any(Array),
    );
    expect(record.userId).toBe('u1');
    expect(record.providerUserId).toBe('gh-1');
  });

  it('create 走事务连接（db 参数传入时不走全局 query）', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [ROW], rowCount: 1 }) };

    await new PgOAuthAccountStore().create('u1', 'github', 'gh-1', db as never);

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('唯一冲突 23505 → OAuthAccountExistsError', async () => {
    const uniqueError = Object.assign(new Error('duplicate key'), { code: '23505' });
    queryMock.mockRejectedValue(uniqueError);

    await expect(new PgOAuthAccountStore().create('u1', 'github', 'gh-1')).rejects.toBeInstanceOf(
      OAuthAccountExistsError,
    );
  });

  it('非 23505 错误原样上抛', async () => {
    const boom = new Error('boom');
    queryMock.mockRejectedValue(boom);

    await expect(new PgOAuthAccountStore().create('u1', 'github', 'gh-1')).rejects.toBe(boom);
  });
});
