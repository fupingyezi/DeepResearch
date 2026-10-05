import { afterAll, describe } from 'vitest';
import { createClient } from 'redis';

import { RedisRunRegistry } from '../redis';
import { describeRunRegistryContract } from '../../__tests__/helpers/contract-cases';

/**
 * RedisRunRegistry 集成套件：需要本机 Redis（REDIS_URL 可达），否则整组跳过。
 * 与进程内实现共用同一组契约用例——跨进程语义不允许在这些用例上变红。
 */

const hasRedis = await (async (): Promise<boolean> => {
  if (!process.env.REDIS_URL) return false;
  try {
    const probe = createClient({
      url: process.env.REDIS_URL,
      socket: { connectTimeout: 2000 },
    });
    await probe.connect();
    await probe.ping();
    await probe.quit();
    return true;
  } catch {
    return false;
  }
})();

const created: RedisRunRegistry[] = [];

describe.skipIf(!hasRedis)('RunRegistry 契约一致性：RedisRunRegistry（集成）', () => {
  describeRunRegistryContract({
    name: 'RedisRunRegistry',
    make: () => {
      const registry = new RedisRunRegistry();
      created.push(registry);
      return registry;
    },
    distributed: true,
  });
});

afterAll(async () => {
  await Promise.all(created.map((r) => r.close().catch(() => undefined)));
  // 清理用例写入的登记键（残留有 TTL 兜底，主动清理避免污染本机开发库）
  try {
    const cleanup = createClient({ url: process.env.REDIS_URL });
    await cleanup.connect();
    await cleanup.del([
      'deerflow:run:owner:r1',
      'deerflow:run:owner:r2',
      'deerflow:run:owner:r3',
      'deerflow:run:cancel:seen:r1',
      'deerflow:thread:running:t1',
      'deerflow:thread:running:t2',
    ]);
    await cleanup.quit();
  } catch {
    // 清理失败不影响用例结果
  }
});
