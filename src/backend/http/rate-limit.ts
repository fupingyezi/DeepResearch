/**
 * 限流实现：Redis 固定窗口计数（跨进程一致），Redis 未配置/不可用时降级进程内 Map。
 *
 * - createRateLimiter：通用计数钩子（withApiHandler 的 rateLimit 槽），窗口内超过
 *   max 即 429 短路。计数 key 缺省为客户端 IP，可用 keyOf 换账号等维度。
 * - loginFailures：账号维度失败计数——连续失败达阈值即锁定该账号的登录入口，
 *   成功登录清零。锁定判定放在密码校验之前，锁定期内不消耗 bcrypt 算力。
 *
 * 固定窗口语义：INCR 后首条计数带 EXPIRE，窗口从首条起算；窗口滑动的误差上限
 * 为一个完整窗口期，对登录/注册这类防滥用场景可接受（令牌桶留给未来需要时）。
 */

import type { NextRequest, NextResponse } from 'next/server';
import { createClient } from 'redis';

// 与事件总线同口径：直接取 createClient 的返回类型，避开 RedisClientType 裸泛型的
// RESP 版本约束不匹配（裸类型固定 RESP2，实际连接按 RESP3）
type RedisClient = ReturnType<typeof createClient>;

import { jsonError } from './errors';

const LOG = '[rate-limit]';

function isDisabled(): boolean {
  return process.env.DEERFLOW_RATE_LIMIT_ENABLED === '0';
}

/** IP 取 x-forwarded-for 首跳（nginx 覆盖写）；开发直连回落 x-real-ip。 */
function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return 'local';
}

// dev 下 HMR 反复求值模块：client 挂 globalThis 防每路重建多连（与 wiring 同款约束）
const globalForRateLimit = globalThis as unknown as {
  __rateLimitRedis?: Promise<RedisClient | null> | null;
};

function getRedis(): Promise<RedisClient | null> {
  if (!process.env.REDIS_URL) return Promise.resolve(null);
  let promise = globalForRateLimit.__rateLimitRedis;
  if (!promise) {
    promise = createClient({ url: process.env.REDIS_URL })
      .on('error', (err) => console.warn(`${LOG} redis error:`, err.message))
      .connect()
      .then((client) => client)
      .catch((error) => {
        console.warn(`${LOG} redis unavailable, fallback to in-memory:`, (error as Error).message);
        return null;
      });
    globalForRateLimit.__rateLimitRedis = promise;
  }
  return promise;
}

/** 进程内降级计数：固定窗口（窗口起点取首条计数时间）。 */
class MemoryWindowCounter {
  private readonly buckets = new Map<string, { count: number; windowStart: number }>();

  incr(key: string, windowMs: number): number {
    const now = Date.now();
    const current = this.buckets.get(key);
    if (!current || now - current.windowStart >= windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return 1;
    }
    current.count += 1;
    if (this.buckets.size > 10000) this.gc(now);
    return current.count;
  }

  get(key: string): number {
    return this.buckets.get(key)?.count ?? 0;
  }

  del(key: string): void {
    this.buckets.delete(key);
  }

  private gc(now: number): void {
    for (const [key, value] of this.buckets) {
      if (now - value.windowStart >= 24 * 3600_000) this.buckets.delete(key);
    }
  }
}

const memory = new MemoryWindowCounter();

async function incr(key: string, windowMs: number): Promise<number> {
  const client = await getRedis();
  if (client) {
    try {
      const count = await client.incr(key);
      if (count === 1) await client.expire(key, Math.max(1, Math.ceil(windowMs / 1000)));
      return count;
    } catch {
      console.warn(`${LOG} redis incr failed, fallback to in-memory`);
      return memory.incr(key, windowMs);
    }
  }
  return memory.incr(key, windowMs);
}

async function getCount(key: string): Promise<number> {
  const client = await getRedis();
  if (client) {
    try {
      const raw = await client.get(key);
      return raw ? Number(raw) : 0;
    } catch {
      return memory.get(key);
    }
  }
  return memory.get(key);
}

async function del(key: string): Promise<void> {
  const client = await getRedis();
  if (client) {
    try {
      await client.del(key);
      return;
    } catch {
      // 进程内兜底计数同时清一遍，Redis 侧残留由窗口 TTL 自行过期
    }
  }
  memory.del(key);
}

export interface RateLimitConfig {
  /** 计数桶名（进 Redis key，跨桶互不干扰） */
  bucket: string;
  /** 窗口内最大请求数 */
  max: number;
  /** 窗口毫秒数 */
  windowMs: number;
  /** 计数 key 后缀；缺省客户端 IP */
  keyOf?: (request: NextRequest) => string;
}

export type RateLimitHook = (
  request: NextRequest,
) => NextResponse | null | Promise<NextResponse | null>;

export function createRateLimiter(config: RateLimitConfig): RateLimitHook {
  const redisKey = (suffix: string): string => `deerflow:rl:${config.bucket}:${suffix}`;
  return async (request) => {
    if (isDisabled()) return null;
    const suffix = config.keyOf ? config.keyOf(request) : clientIp(request);
    const count = await incr(redisKey(suffix), config.windowMs);
    if (count > config.max) {
      return jsonError('RATE_LIMITED', 'Too many requests, please try again later', 429);
    }
    return null;
  };
}

/** 账号维度失败锁定阈值与窗口：5 次失败锁 15 分钟（成功登录清零）。 */
const LOGIN_FAIL_MAX = 5;
const LOGIN_FAIL_WINDOW_MS = 15 * 60_000;

const loginFailKey = (email: string): string => `deerflow:rl:loginfail:${email.toLowerCase()}`;

export const loginFailures = {
  record(email: string): Promise<void> {
    return incr(loginFailKey(email), LOGIN_FAIL_WINDOW_MS).then(() => undefined);
  },

  clear(email: string): Promise<void> {
    return del(loginFailKey(email));
  },

  async isLocked(email: string): Promise<boolean> {
    if (isDisabled()) return false;
    return (await getCount(loginFailKey(email))) >= LOGIN_FAIL_MAX;
  },
};

export const noopRateLimit: RateLimitHook = () => null;
