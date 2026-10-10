/**
 * 进程间互斥锁（DistLock）：进程内 Map / Redis 双实现，契约一致。
 *
 * 锁只服务短临界区——拿锁 → 改状态 → 释放，毫秒到秒级。TTL 只是持有者
 * 进程崩溃后的兜底回收，不做续期；临界区变长应该拆细，而不是给锁加续期循环。
 * 释放必须校验 token：TTL 过期后他人可能已拿上同一把锁，裸 DEL 会误删别人的锁。
 *
 * Redis 降级语义与 run-registry / docker-coordinator 一致：REDIS_URL 未配置、
 * 连接失败、任一操作失败 → 永久降级进程内实现（只告警一次）。降级后单进程
 * 内互斥仍正确，跨进程互斥失效。
 */

import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';

type RedisClient = ReturnType<typeof createClient>;

const LOG = '[dist-lock]';

/** 释放脚本：token 匹配才 DEL，返回值 1=已删 / 0=未持有（他人已占或已过期）。 */
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

export interface DistLockHandle {
  /** 释放锁；已不持有（TTL 过期后他人拿上）时是 no-op。 */
  release(): Promise<void>;
}

export interface DistLock {
  /** 非阻塞获取：已被持有时返回 null，由调用方决定等待策略。 */
  acquire(key: string, ttlMs: number): Promise<DistLockHandle | null>;
  isDistributed(): boolean;
}

export class InMemoryDistLock implements DistLock {
  private readonly held = new Map<string, string>();

  isDistributed(): boolean {
    return false;
  }

  async acquire(key: string, ttlMs: number): Promise<DistLockHandle | null> {
    void ttlMs; // 进程内实现无过期：持有者进程退出时锁随进程消失，TTL 只在 Redis 实现有意义
    if (this.held.has(key)) return null;
    const token = randomUUID();
    this.held.set(key, token);
    return {
      release: async () => {
        if (this.held.get(key) === token) this.held.delete(key);
      },
    };
  }
}

export class RedisDistLock implements DistLock {
  private client: RedisClient | null = null;
  private connecting: Promise<RedisClient | null> | null = null;
  private connected = false;
  private degraded = false;
  private degradeWarned = false;
  private readonly fallback = new InMemoryDistLock();

  constructor(options?: { client?: RedisClient }) {
    if (options?.client) {
      this.client = options.client;
      this.connected = true;
    }
  }

  isDistributed(): boolean {
    return this.connected && !this.degraded;
  }

  async acquire(key: string, ttlMs: number): Promise<DistLockHandle | null> {
    const client = await this.ensureClient();
    if (!client) return this.fallback.acquire(key, ttlMs);
    const token = randomUUID();
    try {
      const ok = await client.set(key, token, { NX: true, PX: ttlMs });
      if (ok !== 'OK') return null;
    } catch (error) {
      return this.degradeAnd(() => this.fallback.acquire(key, ttlMs), error);
    }
    return {
      release: async () => {
        try {
          await client.eval(RELEASE_SCRIPT, { keys: [key], arguments: [token] });
        } catch (error) {
          this.enterDegraded((error as Error)?.message ?? String(error));
        }
      },
    };
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.quit().catch(() => undefined);
    }
    this.client = null;
    this.connected = false;
  }

  private async ensureClient(): Promise<RedisClient | null> {
    if (this.degraded) return null;
    if (this.connected && this.client) return this.client;
    if (!process.env.REDIS_URL) {
      this.enterDegraded('REDIS_URL 未配置');
      return null;
    }
    if (!this.connecting) {
      this.connecting = this.connect();
    }
    return this.connecting;
  }

  private async connect(): Promise<RedisClient | null> {
    try {
      const client = createClient({
        url: process.env.REDIS_URL,
        socket: {
          keepAlive: true,
          connectTimeout: 10_000,
          reconnectStrategy: (retries) => {
            if (retries > 3) return new Error('Redis 重连次数过多');
            return Math.min(retries * 200, 3000);
          },
        },
      });
      client.on('error', (err) => {
        console.warn(`${LOG} Redis error:`, err.message);
      });
      await client.connect();
      this.client = client;
      this.connected = true;
      console.info(`${LOG} 已连接 Redis，启用跨进程互斥锁`);
      return client;
    } catch (error) {
      this.enterDegraded((error as Error)?.message ?? String(error));
      return null;
    } finally {
      this.connecting = null;
    }
  }

  private enterDegraded(reason: string): void {
    this.degraded = true;
    this.connected = false;
    if (!this.degradeWarned) {
      this.degradeWarned = true;
      console.warn(`${LOG} 降级为进程内互斥锁（单进程正确，多进程尽力而为）。原因: ${reason}`);
    }
  }

  private degradeAnd<T>(fallback: () => T, error: unknown): T {
    this.enterDegraded((error as Error)?.message ?? String(error));
    return fallback();
  }
}

let _instance: DistLock | null = null;

/** 模块级懒单例：配置了 REDIS_URL 用 Redis 锁（连接失败自降级），否则进程内锁。 */
export function getDistLock(): DistLock {
  if (_instance) return _instance;
  _instance = process.env.REDIS_URL ? new RedisDistLock() : new InMemoryDistLock();
  return _instance;
}

/** 仅供测试使用：重置单例。 */
export function resetDistLock(): void {
  _instance = null;
}
