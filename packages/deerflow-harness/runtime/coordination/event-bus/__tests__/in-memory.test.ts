import { describe, expect, it } from 'vitest';

import { InMemoryRunEventBus } from '../in-memory';
import {
  ClientAgentEventType,
  createClientAgentEvent,
  type ClientAgentEvent,
  type StampedClientAgentEvent,
} from '../../../sse/client-event';

/**
 * InMemoryRunEventBus 实现语义（契约之外的游标 / 墓碑行为）：
 * 事件面留在进程内的形态下，这些行为是断点续读与释放后重连的基础。
 */

const ev = (type: ClientAgentEventType, payload: object): ClientAgentEvent =>
  createClientAgentEvent(type, 'lead', payload as never);

const chunk = (text: string) => ev(ClientAgentEventType.STREAM_CHUNK, { text });
const end = () => ev(ClientAgentEventType.END, {});

/** 读流直到迭代器结束（END / close 终止），返回带游标的事件序列。 */
async function collectAll(
  stream: AsyncIterable<StampedClientAgentEvent>,
): Promise<StampedClientAgentEvent[]> {
  const out: StampedClientAgentEvent[] = [];
  for await (const stamped of stream) out.push(stamped);
  return out;
}

/** 读流直到迭代器结束，或超时（防挂在永不终止的流上）。 */
async function collectWithTimeout(
  stream: AsyncIterable<StampedClientAgentEvent>,
  ms: number,
): Promise<StampedClientAgentEvent[]> {
  const done = collectAll(stream).then((v) => ({ kind: 'done' as const, v }));
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) =>
    setTimeout(() => resolve({ kind: 'timeout' }), ms),
  );
  const result = await Promise.race([done, timeout]);
  return result.kind === 'done' ? result.v : [];
}

const chunkTexts = (stamped: StampedClientAgentEvent[]): string[] =>
  stamped
    .filter((s) => s.event.eventType === ClientAgentEventType.STREAM_CHUNK)
    .map((s) => (s.event.payload as { text: string }).text);

describe('InMemoryRunEventBus 游标', () => {
  it('eventId 按 run 单调递增（十进制字符串，publish 顺序即游标顺序）', async () => {
    const bus = new InMemoryRunEventBus();
    await bus.publish('t', 'r', chunk('a'));
    await bus.publish('t', 'r', chunk('b'));
    await bus.publish('t', 'r', chunk('c'));
    await bus.publish('t', 'r', end());

    const ids = (await collectAll(bus.subscribe('t', 'r'))).map((s) => s.eventId);
    expect(ids).toEqual(['1', '2', '3', '4']);

    // 不同 run 各自独立计数
    await bus.publish('t', 'r2', chunk('x'));
    await bus.publish('t', 'r2', end());
    const ids2 = (await collectAll(bus.subscribe('t', 'r2'))).map((s) => s.eventId);
    expect(ids2).toEqual(['1', '2']);
  });

  it('fromEventId 只交付游标之后的事件，实时事件同样过滤（过滤在交付侧）', async () => {
    const bus = new InMemoryRunEventBus();
    await bus.publish('t', 'r', chunk('a'));
    await bus.publish('t', 'r', chunk('b'));

    const reading = collectAll(bus.subscribe('t', 'r', '1'));
    // 游标之后到达的实时事件也必须经游标过滤（不是只对回放过滤）
    await bus.publish('t', 'r', chunk('c'));
    await bus.publish('t', 'r', end());

    const stamped = await reading;
    expect(chunkTexts(stamped)).toEqual(['b', 'c']);
    expect(stamped.map((s) => s.eventId)).toEqual(['2', '3', '4']);
  });

  it('非法游标按全量回放（与缺省一致）', async () => {
    const bus = new InMemoryRunEventBus();
    await bus.publish('t', 'r', chunk('a'));
    await bus.publish('t', 'r', chunk('b'));
    await bus.publish('t', 'r', end());

    const byGarbage = await collectAll(bus.subscribe('t', 'r', 'not-a-number'));
    const byDefault = await collectAll(bus.subscribe('t', 'r'));
    expect(byGarbage.map((s) => s.eventId)).toEqual(['1', '2', '3']);
    expect(byDefault.map((s) => s.eventId)).toEqual(['1', '2', '3']);
  });
});

describe('InMemoryRunEventBus release 墓碑', () => {
  it('release 后再订阅立即结束（空流，不挂起），发布历史随 buffer 一并释放', async () => {
    const bus = new InMemoryRunEventBus();
    await bus.publish('t', 'r', chunk('a'));
    await bus.release('t', 'r');

    const stamped = await collectWithTimeout(bus.subscribe('t', 'r'), 200);
    expect(stamped).toEqual([]);
  });

  it('release 后 publish 重建新流（序号重新起算），墓碑清空不再拦截', async () => {
    const bus = new InMemoryRunEventBus();
    await bus.publish('t', 'r', chunk('a'));
    await bus.release('t', 'r');
    // release 之后的 publish 属于新一轮生命周期：channel 重建、游标重新起算
    await bus.publish('t', 'r', chunk('x'));
    await bus.publish('t', 'r', end());

    const stamped = await collectAll(bus.subscribe('t', 'r'));
    expect(chunkTexts(stamped)).toEqual(['x']);
    expect(stamped.map((s) => s.eventId)).toEqual(['1', '2']);
  });

  it('未释放的 run：订阅后 publish 的实时事件正常送达，END 终止迭代', async () => {
    const bus = new InMemoryRunEventBus();
    const reading = collectAll(bus.subscribe('t', 'r'));
    await bus.publish('t', 'r', chunk('a'));
    await bus.publish('t', 'r', end());

    const stamped = await reading;
    expect(stamped.map((s) => s.event.eventType)).toEqual([
      ClientAgentEventType.STREAM_CHUNK,
      ClientAgentEventType.END,
    ]);
  });
});
