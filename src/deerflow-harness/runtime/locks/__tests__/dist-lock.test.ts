import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemoryDistLock, RedisDistLock } from '../dist-lock';

/**
 * DistLock 单元测试：进程内实现的互斥语义 + Redis 实现的键布局 / token 释放 /
 * 故障降级路径（注入假客户端，不含真实 Redis，集成语义由 integration 套件覆盖）。
 */

class FakeRedisClient {
  readonly store = new Map<string, { value: string; px: number }>();
  readonly evals: Array<{ keys: string[]; args: string[] }> = [];
  /** 指定命令抛错，模拟 Redis 故障触发降级 */
  failOps: Set<string> | null = null;
  connected = false;

  on(): void {}
  async connect(): Promise<void> {
    this.connected = true;
  }
  async quit(): Promise<void> {
    this.connected = false;
  }

  async set(key: string, value: string, opts?: { NX?: boolean; PX?: number }) {
    this.check('set');
    if (opts?.NX && this.store.has(key)) return null;
    this.store.set(key, { value, px: opts?.PX ?? 0 });
    return 'OK';
  }

  async eval(script: string, opts: { keys: string[]; arguments: string[] }) {
    void script;
    this.check('eval');
    this.evals.push({ keys: opts.keys, args: opts.arguments });
    const [key] = opts.keys;
    const [token] = opts.arguments;
    const entry = this.store.get(key);
    if (!entry || entry.value !== token) return 0;
    this.store.delete(key);
    return 1;
  }

  private check(op: string): void {
    if (this.failOps?.has(op)) throw new Error(`fake failure: ${op}`);
  }
}

describe('InMemoryDistLock', () => {
  it('同一 key 互斥：持有时他人拿不到，释放后可再拿', async () => {
    const lock = new InMemoryDistLock();
    const h1 = await lock.acquire('k', 10_000);
    expect(h1).not.toBeNull();
    expect(await lock.acquire('k', 10_000)).toBeNull();

    await h1!.release();
    const h2 = await lock.acquire('k', 10_000);
    expect(h2).not.toBeNull();
    await h2!.release();
    expect(lock.isDistributed()).toBe(false);
  });

  it('不同 key 互不干扰', async () => {
    const lock = new InMemoryDistLock();
    const h1 = await lock.acquire('a', 10_000);
    const h2 = await lock.acquire('b', 10_000);
    expect(h1).not.toBeNull();
    expect(h2).not.toBeNull();
    await h1!.release();
    await h2!.release();
  });
});

describe('RedisDistLock（假客户端）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('acquire 用 SET NX PX 占锁，release 用 token 校验删除', async () => {
    const fake = new FakeRedisClient();
    const lock = new RedisDistLock({ client: fake as never });

    const handle = await lock.acquire('lk', 12_345);
    expect(handle).not.toBeNull();
    const [key, entry] = [...fake.store.entries()][0];
    expect(key).toBe('lk');
    expect(entry.px).toBe(12_345);

    // 持有期间再拿 → null
    expect(await lock.acquire('lk', 12_345)).toBeNull();

    await handle!.release();
    expect(fake.evals.length).toBe(1);
    expect(fake.evals[0].keys).toEqual(['lk']);
    expect(fake.store.size).toBe(0);
    expect(lock.isDistributed()).toBe(true);
  });

  it('release 的 token 不匹配时不删键（TTL 过期后他人已占的场景）', async () => {
    const fake = new FakeRedisClient();
    const lock = new RedisDistLock({ client: fake as never });
    const h1 = await lock.acquire('lk', 1000);
    // 模拟 TTL 过期后他人拿上同一把锁：直接改写 store
    fake.store.set('lk', { value: 'someone-else', px: 1000 });
    await h1!.release();
    expect(fake.store.get('lk')!.value).toBe('someone-else');
  });

  it('Redis 操作失败 → 永久降级进程内实现并只告警一次', async () => {
    const fake = new FakeRedisClient();
    fake.failOps = new Set(['set']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lock = new RedisDistLock({ client: fake as never });

    // 第一次失败：降级并告警
    const h1 = await lock.acquire('lk', 1000);
    expect(h1).not.toBeNull(); // fallback 进程内锁照常可用
    expect(lock.isDistributed()).toBe(false);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('降级为进程内互斥锁'))).toHaveLength(
      1,
    );

    // 降级后互斥语义仍在（进程内），且不再碰 Redis
    fake.failOps = null;
    expect(await lock.acquire('lk', 1000)).toBeNull();
    await h1!.release();
    expect(fake.store.size).toBe(0);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('降级为进程内互斥锁'))).toHaveLength(
      1,
    );
  });
});
