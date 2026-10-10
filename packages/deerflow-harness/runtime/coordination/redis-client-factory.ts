/**
 * RedisClientFactory —— Redis 客户端的注入面。
 *
 * harness 内 4 个跨进程组件（event-bus / run-registry / dist-lock /
 * docker-coordinator）需要 redis 连接，但连接串（REDIS_URL）是宿主部署配置：
 * 由宿主注册工厂（`createClient` 的薄包装，注入 url 等部署参数），组件只传
 * 各自动态的 socket 选项。工厂未注册 = 宿主未配置 Redis，组件走进程内降级。
 */

import type { createClient } from 'redis';

export type RedisClientOptions = Parameters<typeof createClient>[0];
export type RedisClient = ReturnType<typeof createClient>;

export type RedisClientFactory = (
  options?: RedisClientOptions,
) => RedisClient | Promise<RedisClient>;

// dev 下注册表挂 globalThis：理由同 title-store.ts（Next 按路由分包编译，
// 模块级变量会分裂成多份导致注入静默失效）。
let _factory: RedisClientFactory | null = null;

const globalForRedisFactory =
  process.env.NODE_ENV === 'production'
    ? null
    : (globalThis as unknown as { __redisClientFactory?: RedisClientFactory | null });

export function setRedisClientFactory(factory: RedisClientFactory | null): void {
  if (globalForRedisFactory) globalForRedisFactory.__redisClientFactory = factory;
  else _factory = factory;
}

export function getRedisClientFactory(): RedisClientFactory | null {
  return globalForRedisFactory?.__redisClientFactory ?? _factory;
}
