import { describe, expect, it, vi } from 'vitest';

import type { RunRegistry, RunEventBus } from '../contracts';
import {
  ClientAgentEventType,
  createClientAgentEvent,
  type ClientAgentEvent,
} from '../sse/client-event';

/**
 * RunRegistry / RunEventBus 的契约一致性用例（按实现参数化复用）：
 *
 * 锁定的语义是 service 依赖的全部契约行为——切换实现时不允许这些用例变红。
 * 只断言契约级语义；实现私有细节由各实现自己的测试单独锁。
 */

export interface RegistryContractImpl {
  name: string;
  make: () => RunRegistry;
  /** isDistributed 的期望值：进程内 false，跨进程 true。 */
  distributed: boolean;
}

export interface EventBusContractImpl {
  name: string;
  make: () => RunEventBus;
  distributed: boolean;
}

const info = (runId: string, threadId: string) => ({
  runId,
  threadId,
  owner: 'proc-1',
  startedAt: 1234,
});

const ev = (type: ClientAgentEventType, payload: object): ClientAgentEvent =>
  createClientAgentEvent(type, 'lead', payload as never);

/** 读流直到结束（END 后 channel close 终止迭代），或到达 n 条提前退出。 */
async function collect(
  stream: AsyncIterable<ClientAgentEvent>,
  n: number,
): Promise<ClientAgentEvent[]> {
  const out: ClientAgentEvent[] = [];
  for await (const e of stream) {
    out.push(e);
    if (out.length >= n) return out;
  }
  return out;
}

export function describeRunRegistryContract(impl: RegistryContractImpl): void {
  describe(`RunRegistry 契约一致性：${impl.name}`, () => {
    it('register → ownerOf 可查、listByThread 按线程可见', async () => {
      const r = impl.make();
      await r.register(info('r1', 't1'));
      await r.register(info('r2', 't1'));
      await r.register(info('r3', 't2'));

      expect(await r.ownerOf('r1')).toMatchObject({ runId: 'r1', threadId: 't1' });
      expect(await r.ownerOf('nope')).toBeNull();
      expect((await r.listByThread('t1')).map((x) => x.runId).sort()).toEqual(['r1', 'r2']);
      expect((await r.listByThread('t2')).map((x) => x.runId)).toEqual(['r3']);
      expect(await r.listByThread('nope')).toEqual([]);
    });

    it('unregister → ownerOf 变空、listByThread 清空；未知 run 注销是 no-op', async () => {
      const r = impl.make();
      await r.register(info('r1', 't1'));
      await r.register(info('r2', 't1'));
      await r.unregister('r1');

      expect(await r.ownerOf('r1')).toBeNull();
      expect((await r.listByThread('t1')).map((x) => x.runId)).toEqual(['r2']);
      // 未知 run 注销不抛错、不破坏其它条目
      await expect(r.unregister('nope')).resolves.toBeUndefined();
      expect((await r.listByThread('t1')).map((x) => x.runId)).toEqual(['r2']);
      // 线程名下全部注销后索引清空
      await r.unregister('r2');
      expect(await r.listByThread('t1')).toEqual([]);
    });

    it('requestCancel：无在跑 run 返回 0；在跑 run 投递成功返回 ≥1，handler 收到 (runId, reason)', async () => {
      const r = impl.make();
      expect(await r.requestCancel('r1', 'why')).toBe(0);

      await r.register(info('r1', 't1'));
      const calls: Array<[string, string]> = [];
      r.onCancelRequest((runId, reason) => {
        calls.push([runId, reason]);
        return 1;
      });

      expect(await r.requestCancel('r1', 'why')).toBeGreaterThanOrEqual(1);
      // 跨进程实现经 Pub/Sub 送达，handler 命中是异步的
      await vi.waitFor(() => {
        expect(calls).toEqual([['r1', 'why']]);
      });
    });

    it('isDistributed 反映实现', async () => {
      const r = impl.make();
      // 先做一次登记：跨进程实现的连接是懒建立的，未连接前 isDistributed 为 false
      await r.register(info('r1', 't1'));
      expect(r.isDistributed()).toBe(impl.distributed);
    });
  });
}

export function describeRunEventBusContract(impl: EventBusContractImpl): void {
  describe(`RunEventBus 契约一致性：${impl.name}`, () => {
    it('晚订阅回放完整历史（发布顺序），END 后流终止', async () => {
      const bus = impl.make();
      await bus.publish('t', 'r', ev(ClientAgentEventType.STREAM_CHUNK, { text: 'a' }));
      await bus.publish('t', 'r', ev(ClientAgentEventType.STREAM_CHUNK, { text: 'b' }));
      await bus.publish('t', 'r', ev(ClientAgentEventType.END, {}));

      const events = await collect(bus.subscribe('t', 'r'), 10);
      expect(events.map((e) => e.eventType)).toEqual([
        ClientAgentEventType.STREAM_CHUNK,
        ClientAgentEventType.STREAM_CHUNK,
        ClientAgentEventType.END,
      ]);
    });

    it('订阅后的事件实时到达且顺序正确，END 终止迭代', async () => {
      const bus = impl.make();
      const stream = bus.subscribe('t', 'r');
      const reader = (async () => collect(stream, 3))();

      await bus.publish('t', 'r', ev(ClientAgentEventType.STREAM_CHUNK, { text: 'a' }));
      await bus.publish('t', 'r', ev(ClientAgentEventType.STREAM_CHUNK, { text: 'b' }));
      await bus.publish('t', 'r', ev(ClientAgentEventType.END, {}));

      const events = await reader;
      expect(events.map((e) => e.eventType)).toEqual([
        ClientAgentEventType.STREAM_CHUNK,
        ClientAgentEventType.STREAM_CHUNK,
        ClientAgentEventType.END,
      ]);
    });

    it('release：未知 run 与重复 release 都不抛错', async () => {
      const bus = impl.make();
      await bus.publish('t', 'r', ev(ClientAgentEventType.STREAM_CHUNK, { text: 'a' }));
      await expect(bus.release('nope', 'nope')).resolves.toBeUndefined();
      await expect(bus.release('t', 'r')).resolves.toBeUndefined();
      await expect(bus.release('t', 'r')).resolves.toBeUndefined();
    });

    it('isDistributed 反映实现', () => {
      expect(impl.make().isDistributed()).toBe(impl.distributed);
    });
  });
}
