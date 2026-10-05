import { describe, expect, it, vi } from 'vitest';
import { createClient } from 'redis';

import { RedisRunRegistry } from '../redis';
import type { RunOwnerInfo } from '../../contracts';

/**
 * RedisRunRegistry 单元测试：注入假客户端，锁键布局、去重窗口、订阅送达与
 * 故障降级路径（不含真实 Redis，集成语义由 integration 套件覆盖）。
 */

const info = (runId: string, threadId: string): RunOwnerInfo => ({
  runId,
  threadId,
  owner: 'proc-1',
  startedAt: 1000,
});

class FakeRedisClient {
  readonly hashes = new Map<string, Record<string, string>>();
  readonly sets = new Map<string, Set<string>>();
  readonly expiries = new Map<string, number>();
  readonly seen = new Set<string>();
  readonly published: Array<{ channel: string; message: string }> = [];
  private readonly listeners = new Map<string, Array<(message: string) => void>>();
  /** 指定命令抛错，模拟 Redis 故障触发降级 */
  failOps: Set<string> | null = null;

  async hSet(key: string, fields: Record<string, string>) {
    this.check('hSet');
    this.hashes.set(key, { ...(this.hashes.get(key) ?? {}), ...fields });
    return 1;
  }

  async hGetAll(key: string) {
    this.check('hGetAll');
    return this.hashes.get(key) ?? {};
  }

  async expire(key: string, seconds: number) {
    this.check('expire');
    this.expiries.set(key, seconds);
    return true;
  }

  async sAdd(key: string, member: string) {
    this.check('sAdd');
    let set = this.sets.get(key);
    if (!set) {
      set = new Set();
      this.sets.set(key, set);
    }
    set.add(member);
    return 1;
  }

  async sRem(key: string, member: string) {
    this.check('sRem');
    this.sets.get(key)?.delete(member);
    return 1;
  }

  async sMembers(key: string) {
    this.check('sMembers');
    return [...(this.sets.get(key) ?? [])];
  }

  async del(key: string) {
    this.check('del');
    this.hashes.delete(key);
    return 1;
  }

  async set(key: string, _value: string, _opts: { NX: true; PX: number }) {
    this.check('set');
    if (this.seen.has(key)) return null;
    this.seen.add(key);
    return 'OK';
  }

  async publish(channel: string, message: string) {
    this.check('publish');
    this.published.push({ channel, message });
    const listeners = this.listeners.get(channel) ?? [];
    for (const listener of listeners) listener(message);
    return listeners.length;
  }

  async subscribe(channel: string, listener: (message: string) => void) {
    this.check('subscribe');
    let listeners = this.listeners.get(channel);
    if (!listeners) {
      listeners = [];
      this.listeners.set(channel, listeners);
    }
    listeners.push(listener);
  }

  async quit() {
    // 假客户端无连接可关
  }

  emit(channel: string, message: string) {
    for (const listener of this.listeners.get(channel) ?? []) listener(message);
  }

  clearSeen(key: string) {
    this.seen.delete(key);
  }

  private check(op: string) {
    if (this.failOps?.has(op)) throw new Error(`fake redis: ${op} failed`);
  }
}

const asClient = (fake: FakeRedisClient) => fake as unknown as ReturnType<typeof createClient>;

describe('RedisRunRegistry（假客户端）', () => {
  it('register 写 owner Hash 与 thread 索引，均带 TTL', async () => {
    const fake = new FakeRedisClient();
    const r = new RedisRunRegistry({ client: asClient(fake) });
    await r.register(info('r1', 't1'));

    expect(fake.hashes.get('deerflow:run:owner:r1')).toEqual({
      threadId: 't1',
      owner: 'proc-1',
      startedAt: '1000',
    });
    expect([...(fake.sets.get('deerflow:thread:running:t1') ?? [])]).toEqual(['r1']);
    expect(fake.expiries.get('deerflow:run:owner:r1')).toBeGreaterThan(0);
    expect(fake.expiries.get('deerflow:thread:running:t1')).toBeGreaterThan(0);
    expect(r.isDistributed()).toBe(true);
  });

  it('owner 键按存活 TTL 登记（3 个心跳窗口）；touch 续租到同一 TTL', async () => {
    const fake = new FakeRedisClient();
    const r = new RedisRunRegistry({ client: asClient(fake) });
    await r.register(info('r1', 't1'));
    expect(fake.expiries.get('deerflow:run:owner:r1')).toBe(45);

    await r.touch('r1');
    expect(fake.expiries.get('deerflow:run:owner:r1')).toBe(45);
    expect(r.isDistributed()).toBe(true);
  });

  it('touch 失败只告警一次、不降级登记表；恢复后告警窗口复位', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = new FakeRedisClient();
    const r = new RedisRunRegistry({ client: asClient(fake) });
    await r.register(info('r1', 't1'));

    fake.failOps = new Set(['expire']);
    await r.touch('r1');
    await r.touch('r1');
    // 续租失败必须保持跨进程协调可用：瞬时失败由下个心跳自愈，不该整体降级
    expect(r.isDistributed()).toBe(true);
    const touchWarns = warn.mock.calls.filter(([m]) => String(m).includes('touch failed'));
    expect(touchWarns).toHaveLength(1);

    fake.failOps = null;
    await r.touch('r1');
    expect(r.isDistributed()).toBe(true);
    warn.mockRestore();
  });

  it('ownerOf / listByThread 解析 Hash；悬挂索引（Hash 已过期）被跳过', async () => {
    const fake = new FakeRedisClient();
    const r = new RedisRunRegistry({ client: asClient(fake) });
    await r.register(info('r1', 't1'));
    // 索引里有、Hash 没有的悬挂条目：索引是投影，Hash 才是登记真相
    fake.sets.get('deerflow:thread:running:t1')!.add('ghost');

    expect(await r.ownerOf('r1')).toMatchObject({ runId: 'r1', threadId: 't1', owner: 'proc-1' });
    expect(await r.ownerOf('ghost')).toBeNull();
    expect((await r.listByThread('t1')).map((x) => x.runId)).toEqual(['r1']);
  });

  it('unregister 清 owner 与索引；本进程镜像缺失时回读 owner Hash 定位线程', async () => {
    const fake = new FakeRedisClient();
    // 镜像缺失路径：只预置 Redis 数据，不经本进程 register（进程重启后清理遗留登记）
    fake.hashes.set('deerflow:run:owner:r9', { threadId: 't9', owner: 'proc-x', startedAt: '1' });
    fake.sets.set('deerflow:thread:running:t9', new Set(['r9']));

    const r = new RedisRunRegistry({ client: asClient(fake) });
    await r.unregister('r9');

    expect(fake.hashes.has('deerflow:run:owner:r9')).toBe(false);
    expect(fake.sets.get('deerflow:thread:running:t9')?.size).toBe(0);
  });

  it('requestCancel：owner 缺失不发布；存在则去重发布，窗口内重复返回 0', async () => {
    const fake = new FakeRedisClient();
    const r = new RedisRunRegistry({ client: asClient(fake) });

    expect(await r.requestCancel('ghost', 'why')).toBe(0);
    expect(fake.published).toHaveLength(0);

    await r.register(info('r1', 't1'));
    expect(await r.requestCancel('r1', 'stopped')).toBe(1);
    // 短窗口去重：第二次同 run 不再广播
    expect(await r.requestCancel('r1', 'stopped')).toBe(0);
    expect(fake.published).toHaveLength(1);
    expect(fake.published[0].channel).toBe('deerflow:run:cancel');
    expect(JSON.parse(fake.published[0].message)).toMatchObject({ runId: 'r1', reason: 'stopped' });
    expect(JSON.parse(fake.published[0].message).issuedBy).toBeTruthy();

    // 窗口过后可再次投递
    fake.clearSeen('deerflow:run:cancel:seen:r1');
    expect(await r.requestCancel('r1', 'again')).toBe(1);
  });

  it('频道消息回调 handler（命中才 abort）；畸形消息静默丢弃', async () => {
    const fake = new FakeRedisClient();
    const r = new RedisRunRegistry({ client: asClient(fake) });
    await r.register(info('r1', 't1'));

    const calls: Array<[string, string]> = [];
    r.onCancelRequest((runId, reason) => {
      calls.push([runId, reason]);
      return runId === 'r1' ? 1 : 0;
    });

    fake.emit('deerflow:run:cancel', JSON.stringify({ runId: 'r1', reason: 'stopped' }));
    expect(calls).toEqual([['r1', 'stopped']]);

    // 畸形消息与缺 runId 的消息都不该让订阅链路崩掉
    fake.emit('deerflow:run:cancel', '{bad json');
    fake.emit('deerflow:run:cancel', JSON.stringify({ reason: 'no runId' }));
    expect(calls).toHaveLength(1);
  });

  it('handler 抛错不打断其余 handler 与订阅链路', async () => {
    const fake = new FakeRedisClient();
    const r = new RedisRunRegistry({ client: asClient(fake) });
    await r.register(info('r1', 't1'));

    const calls: string[] = [];
    r.onCancelRequest(() => {
      throw new Error('boom');
    });
    r.onCancelRequest((runId) => {
      calls.push(runId);
      return 1;
    });

    fake.emit('deerflow:run:cancel', JSON.stringify({ runId: 'r1', reason: 'x' }));
    expect(calls).toEqual(['r1']);
  });

  it('任一操作失败 → 永久降级为进程内兜底，只告警一次，后续不再碰 Redis', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = new FakeRedisClient();
    const r = new RedisRunRegistry({ client: asClient(fake) });
    await r.register(info('r1', 't1'));
    expect(r.isDistributed()).toBe(true);

    fake.failOps = new Set(['hSet']);
    await r.register(info('r2', 't2'));
    expect(r.isDistributed()).toBe(false);

    // 降级后走进程内兜底：降级后登记的 run 可见，Redis 侧数据不再参与
    expect(await r.ownerOf('r2')).toMatchObject({ runId: 'r2', threadId: 't2' });
    expect(await r.ownerOf('r1')).toBeNull();
    await r.register(info('r3', 't3'));
    expect(await r.ownerOf('r3')).toMatchObject({ runId: 'r3' });
    expect(fake.hashes.size).toBe(1); // 只有 r1 写进过 Redis

    // 告警只一次（后续失败不再重复）
    fake.failOps = new Set(['hGetAll']);
    await r.ownerOf('r9');
    const degradeWarns = warn.mock.calls.filter(([msg]) => String(msg).includes('降级'));
    expect(degradeWarns).toHaveLength(1);
    warn.mockRestore();
  });

  it('close() 幂等、关闭后 isDistributed 为 false', async () => {
    const fake = new FakeRedisClient();
    const r = new RedisRunRegistry({ client: asClient(fake) });
    await r.register(info('r1', 't1'));
    await r.close();
    await expect(r.close()).resolves.toBeUndefined();
    expect(r.isDistributed()).toBe(false);
  });
});
