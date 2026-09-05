/**
 * 沙箱跨进程协调模块（单机多进程 / PM2 形态）。
 *
 * 背景：多个 Node 进程共享同一个 Docker daemon，进程内 Map 不再是唯一真相源。
 * 本模块以 Redis 承载「跨进程计数 / 登记 / 分布式锁」，让任一进程的并发限流、
 * 空闲回收、启动对账都基于共享状态，避免各进程各自为政导致容器超配。
 *
 * 设计取舍：
 * - 容器存在的最终真相源是 Docker daemon（docker ps 按 name 前缀），Redis 仅承载
 *   协调元数据；两者对账由 provider 的 reconcile 完成。
 * - Redis 不可用时降级为「进程内 Map」语义：单进程内正确，多进程尽力而为，不阻断
 *   对话（对齐 lib/cache 连接失败返回 null 不抛错的现状）。降级仅告警一次。
 * - 计数用 Lua 脚本做「读上限 + 判断 + 自增」的原子占位，杜绝多进程竞态超配。
 *
 * 复用现有 redis 依赖与 REDIS_URL；不污染 lib/cache 通用缓存（其对 value 做
 * JSON stringify/parse，不适合整数计数与原子命令），故独立建连接。
 */

import { createClient } from 'redis';

type RedisClient = ReturnType<typeof createClient>;

const KEY_PREFIX = 'deerflow:sandbox:';
const CONTAINERS_COUNT_KEY = `${KEY_PREFIX}containers:count`;
const RUNS_COUNT_KEY = `${KEY_PREFIX}runs:count`;
const THREAD_HASH_PREFIX = `${KEY_PREFIX}thread:`;
const THREAD_INDEX_KEY = `${KEY_PREFIX}threads`;
const ACQUIRE_LOCK_PREFIX = `${KEY_PREFIX}lock:acquire:`;
const REAP_LOCK_KEY = `${KEY_PREFIX}lock:reap`;

const LOG = '[docker-coordinator]';

/** Lua：读取计数，未达上限则自增并返回 1，否则返回 0（原子占位，防竞态超配）。 */
const RESERVE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(ARGV[1])
if current < limit then
  redis.call('INCR', KEYS[1])
  return 1
end
return 0
`;

/** Lua：计数自减，但不低于 0（释放，防负数漂移）。 */
const RELEASE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current > 0 then
  return redis.call('DECR', KEYS[1])
end
return 0
`;

export interface ThreadRegistration {
  threadId: string;
  containerName: string;
  /** 最近一次活跃时间（毫秒）；空闲回收据此判定。 */
  lastActiveAt: number;
  /** 当前引用计数（正在使用该容器的 run/agent 层数）。 */
  refCount: number;
}

export interface IdleCandidate {
  threadId: string;
  containerName: string;
  lastActiveAt: number;
}

/**
 * 沙箱协调契约。Redis 可用时为跨进程实现，不可用时为进程内 Map 实现，
 * 二者语义一致，调用方无需感知。
 */
export interface SandboxCoordinator {
  /** 原子占位一个容器名额；返回 false 表示已达 maxLive。 */
  tryReserveContainer(maxLive: number): Promise<boolean>;
  releaseContainer(): Promise<void>;
  /** 原子占位一个 run 名额；返回 false 表示已达 maxRuns。 */
  tryReserveRun(maxRuns: number): Promise<boolean>;
  releaseRun(): Promise<void>;

  /** 登记 thread→container 映射（refCount 从 0 起，由 retain/incRef 显式持有）。 */
  register(threadId: string, containerName: string): Promise<void>;
  unregister(threadId: string): Promise<void>;
  getRegistration(threadId: string): Promise<ThreadRegistration | null>;
  listRegistrations(): Promise<ThreadRegistration[]>;

  /** 刷新活跃时间（命令执行/心跳时调用）。 */
  touch(threadId: string): Promise<void>;
  incRef(threadId: string): Promise<number>;
  decRef(threadId: string): Promise<number>;

  /** 列出 refCount==0 且空闲超过 idleTimeoutMs 的可回收容器。 */
  listIdleCandidates(idleTimeoutMs: number): Promise<IdleCandidate[]>;

  /**
   * 在 acquire 锁保护下执行 fn（防多进程并发重复建同名容器）。
   * 抢锁失败返回 null（调用方据此走复用/等待路径）。
   */
  withAcquireLock<T>(containerName: string, ttlMs: number, fn: () => Promise<T>): Promise<T | null>;

  /** 抢占回收器互斥锁；成功返回 true（调用方执行回收后需 releaseReapLock）。 */
  tryReapLock(ttlMs: number): Promise<boolean>;
  releaseReapLock(): Promise<void>;

  /** 是否运行在 Redis 跨进程模式（false 表示降级为进程内）。 */
  isDistributed(): boolean;
}

let coordinatorSingleton: SandboxCoordinator | null = null;

/** 获取进程级协调器单例：Redis 可连则用分布式实现，否则降级进程内实现。 */
export function getSandboxCoordinator(): SandboxCoordinator {
  if (coordinatorSingleton === null) {
    coordinatorSingleton = new RedisSandboxCoordinator();
  }
  return coordinatorSingleton;
}

/** 测试注入用；重置后下次 get 重新创建。 */
export function setSandboxCoordinator(coordinator: SandboxCoordinator | null): void {
  coordinatorSingleton = coordinator;
}

function threadHashKey(threadId: string): string {
  return `${THREAD_HASH_PREFIX}${threadId}`;
}

/**
 * 进程内降级实现：Redis 不可用时使用。语义与分布式实现一致，
 * 但仅在本进程内有效（多进程下为尽力而为）。
 */
class InProcessCoordinatorState {
  containerCount = 0;
  runCount = 0;
  readonly registrations = new Map<string, ThreadRegistration>();
  readonly acquireLocks = new Set<string>();
  reapLockUntil = 0;
}

/**
 * Redis 协调实现，内建降级：任何 Redis 操作失败即切换到进程内状态，
 * 保证不因 Redis 抖动阻断对话。
 */
class RedisSandboxCoordinator implements SandboxCoordinator {
  private client: RedisClient | null = null;
  private connecting: Promise<RedisClient | null> | null = null;
  private connected = false;
  private degraded = false;
  private degradeWarned = false;
  private readonly local = new InProcessCoordinatorState();

  isDistributed(): boolean {
    return this.connected && !this.degraded;
  }

  async tryReserveContainer(maxLive: number): Promise<boolean> {
    const client = await this.ensureClient();
    if (!client) {
      if (this.local.containerCount >= maxLive) return false;
      this.local.containerCount += 1;
      return true;
    }
    try {
      const reserved = await client.eval(RESERVE_SCRIPT, {
        keys: [CONTAINERS_COUNT_KEY],
        arguments: [String(maxLive)],
      });
      return Number(reserved) === 1;
    } catch (error) {
      return this.degradeAnd(() => {
        if (this.local.containerCount >= maxLive) return false;
        this.local.containerCount += 1;
        return true;
      }, error);
    }
  }

  async releaseContainer(): Promise<void> {
    const client = await this.ensureClient();
    if (!client) {
      this.local.containerCount = Math.max(0, this.local.containerCount - 1);
      return;
    }
    try {
      await client.eval(RELEASE_SCRIPT, { keys: [CONTAINERS_COUNT_KEY], arguments: [] });
    } catch (error) {
      this.degradeAnd(() => {
        this.local.containerCount = Math.max(0, this.local.containerCount - 1);
        return undefined;
      }, error);
    }
  }

  async tryReserveRun(maxRuns: number): Promise<boolean> {
    const client = await this.ensureClient();
    if (!client) {
      if (this.local.runCount >= maxRuns) return false;
      this.local.runCount += 1;
      return true;
    }
    try {
      const reserved = await client.eval(RESERVE_SCRIPT, {
        keys: [RUNS_COUNT_KEY],
        arguments: [String(maxRuns)],
      });
      return Number(reserved) === 1;
    } catch (error) {
      return this.degradeAnd(() => {
        if (this.local.runCount >= maxRuns) return false;
        this.local.runCount += 1;
        return true;
      }, error);
    }
  }

  async releaseRun(): Promise<void> {
    const client = await this.ensureClient();
    if (!client) {
      this.local.runCount = Math.max(0, this.local.runCount - 1);
      return;
    }
    try {
      await client.eval(RELEASE_SCRIPT, { keys: [RUNS_COUNT_KEY], arguments: [] });
    } catch (error) {
      this.degradeAnd(() => {
        this.local.runCount = Math.max(0, this.local.runCount - 1);
        return undefined;
      }, error);
    }
  }

  async register(threadId: string, containerName: string): Promise<void> {
    const now = Date.now();
    const client = await this.ensureClient();
    if (!client) {
      const existing = this.local.registrations.get(threadId);
      this.local.registrations.set(threadId, {
        threadId,
        containerName,
        lastActiveAt: now,
        // 保留已有 refCount：retain 可能先于 register（middleware 同步链），
        // 不能重置，否则丢失持有计数。
        refCount: existing?.refCount ?? 0,
      });
      return;
    }
    try {
      const key = threadHashKey(threadId);
      // 不写 refCount：由 incRef/decRef（hIncrBy）独立管理，字段缺省视为 0，
      // 避免 register 与 retain 竞态互相覆盖。
      await client.hSet(key, {
        containerName,
        lastActiveAt: String(now),
      });
      await client.sAdd(THREAD_INDEX_KEY, threadId);
    } catch (error) {
      this.degradeAnd(() => {
        const existing = this.local.registrations.get(threadId);
        this.local.registrations.set(threadId, {
          threadId,
          containerName,
          lastActiveAt: now,
          refCount: existing?.refCount ?? 0,
        });
        return undefined;
      }, error);
    }
  }

  async unregister(threadId: string): Promise<void> {
    const client = await this.ensureClient();
    if (!client) {
      this.local.registrations.delete(threadId);
      return;
    }
    try {
      await client.del(threadHashKey(threadId));
      await client.sRem(THREAD_INDEX_KEY, threadId);
    } catch (error) {
      this.degradeAnd(() => {
        this.local.registrations.delete(threadId);
        return undefined;
      }, error);
    }
  }

  async getRegistration(threadId: string): Promise<ThreadRegistration | null> {
    const client = await this.ensureClient();
    if (!client) {
      return this.local.registrations.get(threadId) ?? null;
    }
    try {
      const hash = await client.hGetAll(threadHashKey(threadId));
      return parseRegistration(threadId, hash);
    } catch (error) {
      return this.degradeAnd(() => this.local.registrations.get(threadId) ?? null, error);
    }
  }

  async listRegistrations(): Promise<ThreadRegistration[]> {
    const client = await this.ensureClient();
    if (!client) {
      return [...this.local.registrations.values()];
    }
    try {
      const threadIds = await client.sMembers(THREAD_INDEX_KEY);
      const result: ThreadRegistration[] = [];
      for (const threadId of threadIds) {
        const hash = await client.hGetAll(threadHashKey(threadId));
        const parsed = parseRegistration(threadId, hash);
        if (parsed) result.push(parsed);
      }
      return result;
    } catch (error) {
      return this.degradeAnd(() => [...this.local.registrations.values()], error);
    }
  }

  async touch(threadId: string): Promise<void> {
    const now = Date.now();
    const client = await this.ensureClient();
    if (!client) {
      const entry = this.local.registrations.get(threadId);
      if (entry) entry.lastActiveAt = now;
      return;
    }
    try {
      await client.hSet(threadHashKey(threadId), 'lastActiveAt', String(now));
    } catch (error) {
      this.degradeAnd(() => {
        const entry = this.local.registrations.get(threadId);
        if (entry) entry.lastActiveAt = now;
        return undefined;
      }, error);
    }
  }

  async incRef(threadId: string): Promise<number> {
    const client = await this.ensureClient();
    if (!client) {
      return this.localIncRef(threadId);
    }
    try {
      const key = threadHashKey(threadId);
      const next = await client.hIncrBy(key, 'refCount', 1);
      await client.hSet(key, 'lastActiveAt', String(Date.now()));
      return Number(next);
    } catch (error) {
      return this.degradeAnd(() => this.localIncRef(threadId), error);
    }
  }

  /**
   * 进程内 incRef：容忍「retain 先于 register」（middleware 同步链导致的常见时序）——
   * 无登记时创建占位（containerName 待 register 补全），保证持有计数不丢失。
   */
  private localIncRef(threadId: string): number {
    const now = Date.now();
    const entry = this.local.registrations.get(threadId);
    if (!entry) {
      this.local.registrations.set(threadId, {
        threadId,
        containerName: '',
        lastActiveAt: now,
        refCount: 1,
      });
      return 1;
    }
    entry.refCount += 1;
    entry.lastActiveAt = now;
    return entry.refCount;
  }

  async decRef(threadId: string): Promise<number> {
    const now = Date.now();
    const client = await this.ensureClient();
    if (!client) {
      const entry = this.local.registrations.get(threadId);
      if (!entry) return 0;
      entry.refCount = Math.max(0, entry.refCount - 1);
      entry.lastActiveAt = now;
      return entry.refCount;
    }
    try {
      const key = threadHashKey(threadId);
      const raw = await client.hIncrBy(key, 'refCount', -1);
      let next = Number(raw);
      if (next < 0) {
        await client.hSet(key, 'refCount', '0');
        next = 0;
      }
      await client.hSet(key, 'lastActiveAt', String(now));
      return next;
    } catch (error) {
      return this.degradeAnd(() => {
        const entry = this.local.registrations.get(threadId);
        if (!entry) return 0;
        entry.refCount = Math.max(0, entry.refCount - 1);
        return entry.refCount;
      }, error);
    }
  }

  async listIdleCandidates(idleTimeoutMs: number): Promise<IdleCandidate[]> {
    const now = Date.now();
    const registrations = await this.listRegistrations();
    return registrations
      .filter((r) => r.refCount <= 0 && now - r.lastActiveAt > idleTimeoutMs)
      .map((r) => ({
        threadId: r.threadId,
        containerName: r.containerName,
        lastActiveAt: r.lastActiveAt,
      }));
  }

  async withAcquireLock<T>(
    containerName: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    const lockKey = `${ACQUIRE_LOCK_PREFIX}${containerName}`;
    const client = await this.ensureClient();
    if (!client) {
      if (this.local.acquireLocks.has(containerName)) return null;
      this.local.acquireLocks.add(containerName);
      try {
        return await fn();
      } finally {
        this.local.acquireLocks.delete(containerName);
      }
    }
    let locked = false;
    try {
      const ok = await client.set(lockKey, '1', { NX: true, PX: ttlMs });
      locked = ok === 'OK';
    } catch (error) {
      return this.degradeAnd(async () => {
        if (this.local.acquireLocks.has(containerName)) return null;
        this.local.acquireLocks.add(containerName);
        try {
          return await fn();
        } finally {
          this.local.acquireLocks.delete(containerName);
        }
      }, error);
    }
    if (!locked) return null;
    try {
      return await fn();
    } finally {
      await client.del(lockKey).catch(() => undefined);
    }
  }

  async tryReapLock(ttlMs: number): Promise<boolean> {
    const client = await this.ensureClient();
    if (!client) {
      const now = Date.now();
      if (this.local.reapLockUntil > now) return false;
      this.local.reapLockUntil = now + ttlMs;
      return true;
    }
    try {
      const ok = await client.set(REAP_LOCK_KEY, '1', { NX: true, PX: ttlMs });
      return ok === 'OK';
    } catch (error) {
      return this.degradeAnd(() => {
        const now = Date.now();
        if (this.local.reapLockUntil > now) return false;
        this.local.reapLockUntil = now + ttlMs;
        return true;
      }, error);
    }
  }

  async releaseReapLock(): Promise<void> {
    this.local.reapLockUntil = 0;
    const client = await this.ensureClient();
    if (!client) return;
    try {
      await client.del(REAP_LOCK_KEY);
    } catch {
      // 锁自带 PX 过期兜底，删除失败可忽略。
    }
  }

  /**
   * 懒连接 Redis。REDIS_URL 未配置或连接失败时返回 null（走进程内降级）。
   * 首次降级打印一次告警，避免刷屏。
   */
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
      console.info(`${LOG} 已连接 Redis，启用跨进程沙箱协调`);
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
      console.warn(`${LOG} 降级为进程内协调（单进程正确，多进程尽力而为）。原因: ${reason}`);
    }
  }

  private degradeAnd<T>(fallback: () => T, error: unknown): T {
    this.enterDegraded((error as Error)?.message ?? String(error));
    return fallback();
  }
}

/** 解析 Redis Hash 为登记结构；hash 为空返回 null。 */
function parseRegistration(
  threadId: string,
  hash: Record<string, string>,
): ThreadRegistration | null {
  if (!hash || !hash.containerName) return null;
  return {
    threadId,
    containerName: hash.containerName,
    lastActiveAt: Number.parseInt(hash.lastActiveAt ?? '0', 10) || 0,
    refCount: Number.parseInt(hash.refCount ?? '0', 10) || 0,
  };
}
