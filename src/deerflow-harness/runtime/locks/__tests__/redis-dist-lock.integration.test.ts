import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from 'redis';

import { RedisDistLock } from '../dist-lock';

/**
 * RedisDistLock 集成测试：真实 Redis 上的互斥语义（两个独立实例共享同一把锁，
 * 模拟两个进程）。无 REDIS_URL 时整套跳过——与 run-registry 集成套件同一约定。
 */

const REDIS_URL = process.env.REDIS_URL;

let hasRedis = false;
if (REDIS_URL) {
  try {
    const probe = createClient({ url: REDIS_URL, socket: { connectTimeout: 2_000 } });
    await probe.connect();
    await probe.ping();
    await probe.quit();
    hasRedis = true;
  } catch {
    hasRedis = false;
  }
}

const KEY_PREFIX = 'deerflow:lock:it:';
const createdKeys: string[] = [];

function trackKey(key: string): void {
  createdKeys.push(key);
}

async function cleanupKeys(): Promise<void> {
  if (!REDIS_URL || createdKeys.length === 0) return;
  const client = createClient({ url: REDIS_URL, socket: { connectTimeout: 2_000 } });
  try {
    await client.connect();
    await client.del(createdKeys);
  } catch {
    // 清理失败不阻塞测试报告
  } finally {
    await client.quit().catch(() => undefined);
  }
}

describe.skipIf(!hasRedis)('RedisDistLock · 真实 Redis', () => {
  const locks: RedisDistLock[] = [];

  beforeAll(() => {
    if (!REDIS_URL) return;
    // 两个实例 = 两个进程的视角：连接独立，锁语义完全靠 Redis
    locks.push(new RedisDistLock(), new RedisDistLock());
  });

  afterAll(async () => {
    for (const lock of locks) {
      await lock.close();
    }
    await cleanupKeys();
  });

  it('跨实例互斥：A 持有 → B 拿不到，A 释放 → B 可拿', async () => {
    const key = `${KEY_PREFIX}${Math.random().toString(36).slice(2)}`;
    trackKey(key);
    const [a, b] = locks;

    const ha = await a.acquire(key, 5_000);
    expect(ha).not.toBeNull();
    expect(a.isDistributed()).toBe(true);

    expect(await b.acquire(key, 5_000)).toBeNull();

    await ha!.release();
    const hb = await b.acquire(key, 5_000);
    expect(hb).not.toBeNull();
    await hb!.release();
  });

  it('重复释放是 no-op，不误删新持有者的锁', async () => {
    const key = `${KEY_PREFIX}${Math.random().toString(36).slice(2)}`;
    trackKey(key);
    const [a, b] = locks;

    const ha = await a.acquire(key, 5_000);
    expect(ha).not.toBeNull();
    expect(await b.acquire(key, 5_000)).toBeNull(); // a 持有期间 b 拿不到

    await ha!.release();
    const hb = await b.acquire(key, 5_000);
    expect(hb).not.toBeNull();
    await ha!.release(); // a 的重复释放：token 已不匹配，no-op
    expect(await b.acquire(key, 5_000)).toBeNull(); // b 的锁还在
    await hb!.release();
  });
});
