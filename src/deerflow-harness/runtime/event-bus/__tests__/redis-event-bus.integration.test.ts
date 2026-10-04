import { afterAll, describe, expect, it } from 'vitest';
import { createClient } from 'redis';

import { RedisEventBus } from '../redis';
import { describeRunEventBusContract } from '../../__tests__/contract-cases';
import {
  ClientAgentEventType,
  createClientAgentEvent,
  type ClientAgentEvent,
  type StampedClientAgentEvent,
} from '../../sse/client-event';

/**
 * RedisEventBus 集成套件：需要本机 Redis（REDIS_URL 可达），否则整组跳过。
 * 与进程内实现共用同一组契约用例，另锁跨实例（不同 Redis 连接）的发布 / 订阅语义。
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

const ev = (type: ClientAgentEventType, payload: object): ClientAgentEvent =>
  createClientAgentEvent(type, 'lead', payload as never);

const chunk = (text: string) => ev(ClientAgentEventType.STREAM_CHUNK, { text });
const end = () => ev(ClientAgentEventType.END, {});

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

const created: RedisEventBus[] = [];
const usedKeys: string[] = [];

/** 每用例独立 key：stream 是追加结构，键跨用例残留会让回放断言互相污染。 */
const makeKeys = (): { threadId: string; runId: string } => {
  const k = { threadId: `t${usedKeys.length}`, runId: `r${usedKeys.length}` };
  usedKeys.push(`deerflow:stream:${k.threadId}:${k.runId}`);
  return k;
};

describe.skipIf(!hasRedis)('RunEventBus 契约一致性：RedisEventBus（集成）', () => {
  describeRunEventBusContract({
    name: 'RedisEventBus',
    make: () => {
      const bus = new RedisEventBus();
      created.push(bus);
      return bus;
    },
    distributed: true,
    makeKeys,
  });
});

describe.skipIf(!hasRedis)('RedisEventBus 跨实例语义（集成）', () => {
  it('A 发布 B 订阅：实时送达、晚订阅回放、游标续读、END 终止', async () => {
    const a = new RedisEventBus();
    const b = new RedisEventBus();
    created.push(a, b);
    expect(a.isDistributed()).toBe(false); // 懒连接：未发布前不算分布式

    // 实时：B 先订阅，A 后发布
    const liveKey = makeKeys();
    const liveReading = collectAll(b.subscribe(liveKey.threadId, liveKey.runId));
    await a.publish(liveKey.threadId, liveKey.runId, chunk('live-1'));
    await a.publish(liveKey.threadId, liveKey.runId, end());
    const liveEvents = await liveReading;
    expect(chunkTexts(liveEvents)).toEqual(['live-1']);

    // 回放：B 晚订阅拿到 A 已发布的完整历史（跨连接）
    const replayKey = makeKeys();
    await a.publish(replayKey.threadId, replayKey.runId, chunk('r-1'));
    await a.publish(replayKey.threadId, replayKey.runId, chunk('r-2'));
    await a.publish(replayKey.threadId, replayKey.runId, chunk('r-3'));
    await a.publish(replayKey.threadId, replayKey.runId, end());
    const all = await collectAll(b.subscribe(replayKey.threadId, replayKey.runId));
    expect(chunkTexts(all)).toEqual(['r-1', 'r-2', 'r-3']);

    // 游标续读：从中间 eventId 起只拿其后的事件（eventId 跨连接可回放）
    const resumed = await collectAll(
      b.subscribe(replayKey.threadId, replayKey.runId, all[1].eventId),
    );
    expect(chunkTexts(resumed)).toEqual(['r-3']);
    expect(resumed.map((s) => s.eventId)).toEqual(all.slice(2).map((s) => s.eventId));

    expect(a.isDistributed()).toBe(true);
    expect(b.isDistributed()).toBe(true);
  });
});

afterAll(async () => {
  if (!hasRedis) return;
  await Promise.all(created.map((b) => b.close().catch(() => undefined)));
  // 清理用例写入的 stream 键（有 24h TTL 兜底，主动清理避免污染本机开发库）
  if (usedKeys.length > 0) {
    try {
      const cleanup = createClient({ url: process.env.REDIS_URL });
      await cleanup.connect();
      await cleanup.del(usedKeys);
      await cleanup.quit();
    } catch {
      // 清理失败不影响用例结果
    }
  }
});
