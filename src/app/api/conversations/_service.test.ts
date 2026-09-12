import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ensureChatSessionRecord 的语义锁定。
 *
 * 背景（别再改回「只在没传 sessionId 时建行」）：
 *   前端首个请求失败收不到 START 时不会重置本地状态，下一轮会把本地临时 UUID 当
 *   「已有会话」发过来。若此时跳过建行，会先落下 threads_meta 孤儿，再由
 *   chat_message.session_id 外键把请求打成 500，run 永远起不来。
 *
 * 用一个内存假表替换 @/lib 的 query（真实实现会连 PG），
 * 覆盖三条语义 + 并发撞主键的自愈路径。
 */

type Row = Record<string, unknown>;

const USER = 'user-1';

/** 假 chat_session 表：按 SQL 形态分派，够用即可。 */
function makeFakeDb(seed: Row[] = []) {
  const table: Row[] = [...seed];
  let insertCount = 0;

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('select * from chat_session where id = $1')) {
      const row = table.find((r) => r.id === params[0]);
      return { rows: row ? [row] : [] };
    }

    if (s.includes('select coalesce(max(seq_id), 0) + 1')) {
      const owned = table.filter((r) => r.user_id === params[0]);
      const max = owned.reduce((acc, r) => Math.max(acc, Number(r.seq_id) || 0), 0);
      return { rows: [{ next_seq_id: max + 1 }] };
    }

    if (s.startsWith('insert into chat_session')) {
      insertCount += 1;
      const id = String(params[0]);
      if (table.some((r) => r.id === id)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
        });
      }
      const row: Row = {
        id,
        seq_id: params[1],
        title: params[2],
        user_id: params[3],
        created_at: params[4],
        updated_at: params[5],
      };
      table.push(row);
      return { rows: [row] };
    }

    throw new Error(`unexpected sql: ${s}`);
  });

  return { query, table, insertCount: () => insertCount };
}

const db = {
  query: vi.fn() as unknown as (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>,
};

vi.mock('@/lib', () => ({
  query: (sql: string, params?: unknown[]) => db.query(sql, params),
  getClient: vi.fn(),
}));

const { ChatSessionAccessError, ensureChatSessionRecord } = await import('./_service');

const sessionRow = (over: Row = {}): Row => ({
  id: 'sess-1',
  seq_id: 1,
  title: '旧标题',
  user_id: USER,
  created_at: '2026-09-12T00:00:00.000Z',
  updated_at: '2026-09-12T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ensureChatSessionRecord', () => {
  it('已存在的自有会话：原样返回，不覆盖标题、不触发 insert', async () => {
    const fake = makeFakeDb([sessionRow({ title: '用户改过的标题' })]);
    db.query = fake.query as unknown as typeof db.query;

    const record = await ensureChatSessionRecord({
      id: 'sess-1',
      title: '这条消息的前 15 字',
      userId: USER,
    });

    expect(record.id).toBe('sess-1');
    expect(record.title).toBe('用户改过的标题');
    expect(fake.insertCount()).toBe(0);
  });

  it('不存在的会话 id：按 createChatSessionRecord 的规则补建（含 seq_id）', async () => {
    const fake = makeFakeDb([sessionRow({ id: 'sess-0', seq_id: 4 })]);
    db.query = fake.query as unknown as typeof db.query;

    const record = await ensureChatSessionRecord({
      id: 'temp-uuid-from-client',
      title: '首条消息前 15 字',
      userId: USER,
    });

    expect(record.id).toBe('temp-uuid-from-client');
    expect(record.title).toBe('首条消息前 15 字');
    expect(record.seq_id).toBe(5); // 沿用 max(seq_id)+1
    expect(fake.insertCount()).toBe(1);
  });

  it('未传 id：新建并生成 uuid', async () => {
    const fake = makeFakeDb();
    db.query = fake.query as unknown as typeof db.query;

    const record = await ensureChatSessionRecord({ title: '新对话', userId: USER });

    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.insertCount()).toBe(1);
  });

  it('会话属于别人：抛 ChatSessionAccessError，不写任何行', async () => {
    const fake = makeFakeDb([sessionRow({ user_id: 'someone-else' })]);
    db.query = fake.query as unknown as typeof db.query;

    await expect(
      ensureChatSessionRecord({ id: 'sess-1', title: 'x', userId: USER }),
    ).rejects.toBeInstanceOf(ChatSessionAccessError);
    expect(fake.insertCount()).toBe(0);
  });

  it('历史行 user_id 为空：视为无主放行（与 harness checkAccess 约定一致）', async () => {
    const fake = makeFakeDb([sessionRow({ user_id: null })]);
    db.query = fake.query as unknown as typeof db.query;

    const record = await ensureChatSessionRecord({ id: 'sess-1', title: 'x', userId: USER });
    expect(record.id).toBe('sess-1');
  });

  it('并发撞主键（23505）：回读已有行返回，不报 500', async () => {
    // 第一次查不到 → insert 撞主键 → 回读拿到并发方插入的行
    const concurrent = sessionRow({ title: '并发方建的标题' });
    const calls: string[] = [];
    db.query = vi.fn(async (sql: string) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      calls.push(s.slice(0, 40));
      if (s.startsWith('select * from chat_session where id = $1')) {
        return {
          rows: calls.filter((c) => c.startsWith('select *')).length > 1 ? [concurrent] : [],
        };
      }
      if (s.includes('select coalesce(max(seq_id), 0) + 1')) return { rows: [{ next_seq_id: 1 }] };
      if (s.startsWith('insert into chat_session')) {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      throw new Error(`unexpected sql: ${s}`);
    }) as unknown as typeof db.query;

    const record = await ensureChatSessionRecord({ id: 'sess-1', title: 'x', userId: USER });
    expect(record.title).toBe('并发方建的标题');
  });
});
