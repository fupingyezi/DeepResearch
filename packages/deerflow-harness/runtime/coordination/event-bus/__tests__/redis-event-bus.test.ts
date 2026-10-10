import { describe, expect, it, vi } from 'vitest';
import { createClient } from 'redis';

import { RedisEventBus } from '../redis';
import {
  ClientAgentEventType,
  createClientAgentEvent,
  type ClientAgentEvent,
  type StampedClientAgentEvent,
} from '../../../sse/client-event';

/**
 * RedisEventBus 单元测试：注入假客户端，锁 XADD/TRIM/EXPIRE、XREAD BLOCK 续读、
 * 游标语义、故障降级与损坏 entry 容错（不含真实 Redis，跨实例语义由集成套件覆盖）。
 */

const ev = (type: ClientAgentEventType, payload: object): ClientAgentEvent =>
  createClientAgentEvent(type, 'lead', payload as never);

const chunk = (text: string) => ev(ClientAgentEventType.STREAM_CHUNK, { text });
const end = () => ev(ClientAgentEventType.END, {});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 读流直到迭代器结束（END 终止），返回带游标的事件序列。 */
async function collectAll(
  stream: AsyncIterable<StampedClientAgentEvent>,
): Promise<StampedClientAgentEvent[]> {
  const out: StampedClientAgentEvent[] = [];
  for await (const stamped of stream) out.push(stamped);
  return out;
}

const chunkTexts = (stamped: StampedClientAgentEvent[]): string[] =>
  stamped
    .filter((s) => s.event.eventType === ClientAgentEventType.STREAM_CHUNK)
    .map((s) => (s.event.payload as { text: string }).text);

interface StreamEntry {
  id: string;
  message: Record<string, string>;
}

interface Waiter {
  resolve: (value: Array<{ name: string; messages: StreamEntry[] }> | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 共享的假数据面：主连接与 duplicate 出的订阅连接读写同一份数据。 */
class FakeRedisState {
  readonly streams = new Map<string, StreamEntry[]>();
  readonly ids = new Map<string, number>();
  readonly expiries = new Map<string, number>();
  readonly trims: Array<{ key: string; options: Record<string, unknown> }> = [];
  readonly waiters = new Map<string, Set<Waiter>>();
  /** 指定命令抛错，模拟 Redis 故障触发重试 / 降级（duplicate 出的订阅连接共享） */
  failOps: Set<string> | null = null;
  /** 全部实例（主 + duplicate）的 quit 总次数 */
  quitCount = 0;
}

class FakeRedisClient {
  readonly state: FakeRedisState;

  get failOps(): Set<string> | null {
    return this.state.failOps;
  }

  set failOps(v: Set<string> | null) {
    this.state.failOps = v;
  }

  constructor(state?: FakeRedisState) {
    this.state = state ?? new FakeRedisState();
  }

  on(): this {
    return this;
  }

  async connect() {
    this.check('connect');
  }

  async quit() {
    this.state.quitCount += 1;
  }

  duplicate(): FakeRedisClient {
    return new FakeRedisClient(this.state);
  }

  async xAdd(
    key: string,
    _id: string,
    message: Record<string, string>,
    options?: { TRIM?: { strategy: string; strategyModifier: string; threshold: number } },
  ): Promise<string> {
    this.check('xAdd');
    const seq = (this.state.ids.get(key) ?? 0) + 1;
    this.state.ids.set(key, seq);
    const newId = `${Date.now()}-${seq}`;
    const entry: StreamEntry = { id: newId, message };
    let list = this.state.streams.get(key);
    if (!list) {
      list = [];
      this.state.streams.set(key, list);
    }
    list.push(entry);
    if (options?.TRIM) {
      this.state.trims.push({ key, options: { ...options.TRIM } });
      const { threshold } = options.TRIM;
      if (typeof threshold === 'number' && list.length > threshold) {
        list.splice(0, list.length - threshold);
      }
    }
    this.wake(key, [{ name: key, messages: [entry] }]);
    return newId;
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    this.check('expire');
    this.state.expiries.set(key, seconds);
    return true;
  }

  async xRead(
    stream: { key: string; id: string },
    options?: { BLOCK?: number; COUNT?: number },
  ): Promise<Array<{ name: string; messages: StreamEntry[] }> | null> {
    this.check('xRead');
    const entries = (this.state.streams.get(stream.key) ?? [])
      .filter((e) => stream.id === '0' || e.id > stream.id)
      .slice(0, options?.COUNT ?? Infinity);
    if (entries.length > 0) return [{ name: stream.key, messages: entries }];
    const block = options?.BLOCK ?? 0;
    if (block <= 0) return null;
    // BLOCK 挂起直到新 entry 到达 / 流被删 / 超时（后两者返回 null，由上层 exists 判定）
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => this.dropWaiter(stream.key, waiter, null), block),
      };
      let set = this.state.waiters.get(stream.key);
      if (!set) {
        set = new Set();
        this.state.waiters.set(stream.key, set);
      }
      set.add(waiter);
    });
  }

  async exists(key: string): Promise<number> {
    this.check('exists');
    return this.state.streams.has(key) ? 1 : 0;
  }

  /** 删除流（模拟 TTL 回收）：唤醒该 key 上全部挂起的 XREAD。 */
  async del(key: string): Promise<number> {
    this.check('del');
    this.state.streams.delete(key);
    this.state.ids.delete(key);
    this.state.expiries.delete(key);
    this.wake(key, null);
    return 1;
  }

  private wake(key: string, value: Array<{ name: string; messages: StreamEntry[] }> | null): void {
    const waiters = this.state.waiters.get(key);
    if (!waiters) return;
    for (const waiter of [...waiters]) this.dropWaiter(key, waiter, value);
  }

  private dropWaiter(
    key: string,
    waiter: Waiter,
    value: Array<{ name: string; messages: StreamEntry[] }> | null,
  ): void {
    const set = this.state.waiters.get(key);
    set?.delete(waiter);
    if (set && set.size === 0) this.state.waiters.delete(key);
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  }

  private check(op: string) {
    if (this.failOps?.has(op)) throw new Error(`fake redis: ${op} failed`);
  }
}

const asClient = (fake: FakeRedisClient) => fake as unknown as ReturnType<typeof createClient>;

const STREAM_KEY = 'deerflow:stream:t:r';

describe('RedisEventBus（假客户端）', () => {
  it('publish：XADD 内联 TRIM + 每次发布刷新 EXPIRE 24h', async () => {
    const fake = new FakeRedisClient();
    const bus = new RedisEventBus({ client: asClient(fake), maxlen: 3 });
    for (const text of ['a', 'b', 'c', 'd']) {
      await bus.publish('t', 'r', chunk(text));
    }

    const list = fake.state.streams.get(STREAM_KEY)!;
    expect(list).toHaveLength(3);
    // MAXLEN 裁剪从最旧开始：'a' 被挤掉
    expect(list.map((e) => JSON.parse(e.message.e).payload.text)).toEqual(['b', 'c', 'd']);
    expect(fake.state.trims.length).toBeGreaterThanOrEqual(1);
    expect(fake.state.trims[0].options).toMatchObject({ strategy: 'MAXLEN', threshold: 3 });
    // TTL 从最后一条事件起算
    expect(fake.state.expiries.get(STREAM_KEY)).toBe(24 * 60 * 60);
  });

  it('subscribe 从头回放完整历史（发布顺序），END 终止迭代并 quit 订阅连接', async () => {
    const fake = new FakeRedisClient();
    const bus = new RedisEventBus({ client: asClient(fake) });
    await bus.publish('t', 'r', chunk('a'));
    await bus.publish('t', 'r', chunk('b'));
    await bus.publish('t', 'r', end());

    const stamped = await collectAll(bus.subscribe('t', 'r'));
    expect(stamped.map((s) => s.event.eventType)).toEqual([
      ClientAgentEventType.STREAM_CHUNK,
      ClientAgentEventType.STREAM_CHUNK,
      ClientAgentEventType.END,
    ]);
    // 迭代结束必须释放订阅连接（duplicate 出的实例 quit）
    expect(fake.state.quitCount).toBe(1);
  });

  it('BLOCK 实时投递：先订阅后发布，事件按序送达', async () => {
    const fake = new FakeRedisClient();
    const bus = new RedisEventBus({ client: asClient(fake), blockMs: 2000 });

    const reading = collectAll(bus.subscribe('t', 'r'));
    await delay(10); // 让订阅连接建立并进入 XREAD BLOCK
    await bus.publish('t', 'r', chunk('a'));
    await bus.publish('t', 'r', chunk('b'));
    await bus.publish('t', 'r', end());

    const stamped = await reading;
    expect(chunkTexts(stamped)).toEqual(['a', 'b']);
  });

  it('游标续读：只交付游标之后的事件；非法游标按全量回放', async () => {
    const fake = new FakeRedisClient();
    const bus = new RedisEventBus({ client: asClient(fake) });
    await bus.publish('t', 'r', chunk('a'));
    await bus.publish('t', 'r', chunk('b'));
    await bus.publish('t', 'r', chunk('c'));
    await bus.publish('t', 'r', end());
    const all = await collectAll(bus.subscribe('t', 'r'));

    const resumed = await collectAll(bus.subscribe('t', 'r', all[0].eventId));
    expect(chunkTexts(resumed)).toEqual(['b', 'c']);
    expect(resumed.map((s) => s.eventId)).toEqual(all.slice(1).map((s) => s.eventId));

    // 非法游标：XREAD 从头读起（与缺省一致）
    const byGarbage = await collectAll(bus.subscribe('t', 'r', 'not-a-cursor'));
    expect(chunkTexts(byGarbage)).toEqual(['a', 'b', 'c']);
  });

  it('BLOCK 超时后流仍在：继续等待，后续发布仍送达', async () => {
    const fake = new FakeRedisClient();
    const bus = new RedisEventBus({ client: asClient(fake), blockMs: 30 });

    const reading = collectAll(bus.subscribe('t', 'r'));
    // 等待跨过 ≥2 个 BLOCK 超时窗口（每次超时都走 exists 存活判定后继续挂起）
    await delay(80);
    await bus.publish('t', 'r', chunk('late'));
    await bus.publish('t', 'r', end());

    const stamped = await reading;
    expect(chunkTexts(stamped)).toEqual(['late']);
  });

  it('见过事件后流被删除（TTL 回收）→ 立即终止迭代', async () => {
    const fake = new FakeRedisClient();
    const bus = new RedisEventBus({ client: asClient(fake), blockMs: 5000 });
    await bus.publish('t', 'r', chunk('a')); // 流存在且本订阅会先回放 'a'

    const reading = collectAll(bus.subscribe('t', 'r'));
    await delay(10); // 回放 'a' 后进入 BLOCK 挂起
    await fake.del(STREAM_KEY); // 唤醒挂起的 XREAD：exists=0 且见过事件 → 终止

    const stamped = await reading;
    expect(chunkTexts(stamped)).toEqual(['a']);
  });

  it('流从未存在（run 未产出首条事件）时 BLOCK 超时 / 流被删都不判死，后续发布仍送达', async () => {
    const fake = new FakeRedisClient();
    const bus = new RedisEventBus({ client: asClient(fake), blockMs: 30 });

    const reading = collectAll(bus.subscribe('t', 'r'));
    // 跨过 ≥2 个超时窗口，再删除「流」——从未见过事件的订阅必须继续等待，
    // 否则 run 首条事件晚于 BLOCK 窗口时订阅会被误杀
    await delay(80);
    await fake.del(STREAM_KEY);
    await bus.publish('t', 'r', chunk('first'));
    await bus.publish('t', 'r', end());

    const stamped = await reading;
    expect(chunkTexts(stamped)).toEqual(['first']);
  });

  it('订阅挂在 XREAD BLOCK 上时 return() 仍立即收束并释放订阅连接', async () => {
    const fake = new FakeRedisClient();
    const bus = new RedisEventBus({ client: asClient(fake), blockMs: 5000 });
    await bus.publish('t', 'r', chunk('a'));

    const it = bus.subscribe('t', 'r')[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(false); // 回放 'a'，下一轮 next 挂进 BLOCK
    const pending = it.next();

    // 无新事件时 BLOCK 永不返回：return 请求若等 yield 边界就会永远挂起，
    // 必须在竞速窗口内收束
    const release = await Promise.race([
      it.return!().then((r) => ({ kind: 'resolved' as const, done: r.done })),
      delay(800).then(() => ({ kind: 'hung' as const })),
    ]);
    expect(release).toEqual({ kind: 'resolved', done: true });
    // 收束必须连带释放订阅连接（duplicate 出的实例 quit）
    expect(fake.state.quitCount).toBe(1);
    await pending; // 被放弃的 next 以 done 收束，不留悬挂
  });

  it('xRead 失败：退避后以同一游标重发，不丢不重', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = new FakeRedisClient();
    const bus = new RedisEventBus({ client: asClient(fake) });
    await bus.publish('t', 'r', chunk('a'));

    fake.failOps = new Set(['xRead']);
    const reading = collectAll(bus.subscribe('t', 'r'));
    setTimeout(() => {
      fake.failOps = null; // 恢复后重试命中同一游标，回放 'a'
    }, 50);
    setTimeout(() => {
      void bus.publish('t', 'r', end());
    }, 150);

    const stamped = await reading;
    expect(chunkTexts(stamped)).toEqual(['a']);
    expect(stamped).toHaveLength(2);
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('xread failed'))).toBe(true);
    warn.mockRestore();
  });

  it('xAdd 失败 → 永久降级进程内兜底（只告警一次），订阅走 fallback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = new FakeRedisClient();
    const bus = new RedisEventBus({ client: asClient(fake) });
    expect(bus.isDistributed()).toBe(true);

    fake.failOps = new Set(['xAdd']);
    await bus.publish('t', 'r', chunk('a'));
    expect(bus.isDistributed()).toBe(false);

    fake.failOps = null;
    await bus.publish('t', 'r', end());
    const stamped = await collectAll(bus.subscribe('t', 'r'));
    expect(chunkTexts(stamped)).toEqual(['a']);

    // 降级告警只一次；后续操作不再重复
    await bus.publish('t', 'r', chunk('b'));
    const degradeWarns = warn.mock.calls.filter(([msg]) => String(msg).includes('降级'));
    expect(degradeWarns).toHaveLength(1);
    warn.mockRestore();
  });

  it('损坏 entry（非法 JSON）跳过不阻断后续事件', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = new FakeRedisClient();
    // 直接预置流数据：损坏 entry 夹在正常 entry 之间
    fake.state.streams.set(STREAM_KEY, [
      { id: '1000-1', message: { e: '{bad json' } },
      { id: '1000-2', message: { e: JSON.stringify(chunk('ok')) } },
      { id: '1000-3', message: { e: JSON.stringify(end()) } },
    ]);
    const bus = new RedisEventBus({ client: asClient(fake) });

    const stamped = await collectAll(bus.subscribe('t', 'r'));
    expect(stamped.map((s) => s.event.eventType)).toEqual([
      ClientAgentEventType.STREAM_CHUNK,
      ClientAgentEventType.END,
    ]);
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('corrupt'))).toBe(true);
    warn.mockRestore();
  });

  it('未配置 REDIS_URL 且未注入客户端 → 直接降级兜底，不尝试连接', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const bus = new RedisEventBus();
      expect(bus.isDistributed()).toBe(false);
      await bus.publish('t', 'r', chunk('a'));
      await bus.publish('t', 'r', end());
      const stamped = await collectAll(bus.subscribe('t', 'r'));
      expect(chunkTexts(stamped)).toEqual(['a']);
      expect(warn.mock.calls.some(([msg]) => String(msg).includes('REDIS_URL 未配置'))).toBe(true);
    } finally {
      if (saved !== undefined) process.env.REDIS_URL = saved;
      warn.mockRestore();
    }
  });

  it('close() 幂等、关闭后 isDistributed 为 false', async () => {
    const fake = new FakeRedisClient();
    const bus = new RedisEventBus({ client: asClient(fake) });
    expect(bus.isDistributed()).toBe(true);
    await bus.close();
    await expect(bus.close()).resolves.toBeUndefined();
    expect(bus.isDistributed()).toBe(false);
  });
});
