import { describe, expect, it, expectTypeOf } from 'vitest';

import {
  ClientAgentEventType,
  createClientAgentEvent,
  type ClientAgentEvent,
  type EndEvent,
  type ErrorPayload,
  type HumanInterruptPayload,
  type StartPayload,
  type StreamChunkPayload,
} from '../../sse/client-event';
import { StreamBridge, ThreadChannel } from '../stream-bridge';

function chunk(text: string): ClientAgentEvent {
  const payload: StreamChunkPayload = { text };
  return createClientAgentEvent(ClientAgentEventType.STREAM_CHUNK, 'lead', payload);
}

function errorEvent(recoverable: boolean): ClientAgentEvent {
  const payload: ErrorPayload = {
    errorCode: 'TEST_ERROR',
    errorMessage: 'boom',
    recoverable,
  };
  return createClientAgentEvent(ClientAgentEventType.ERROR, 'lead', payload);
}

function endEvent(): ClientAgentEvent {
  return createClientAgentEvent(ClientAgentEventType.END, 'lead', {});
}

function startEvent(): ClientAgentEvent {
  const payload: StartPayload = { sessionId: 's1' };
  return createClientAgentEvent(ClientAgentEventType.START, 'lead', payload);
}

function interruptEvent(): ClientAgentEvent {
  const payload: HumanInterruptPayload = { question: '确认？', details: null };
  return createClientAgentEvent(ClientAgentEventType.HUMAN_INTERRUPT, 'lead', payload);
}

/** 裸事件载荷的事件名提取器：ThreadChannel / StreamBridge 的裁剪与终止判定只问事件名。 */
const eventNameOf = (ev: ClientAgentEvent) => ev.eventType;

/** 收集一个订阅的全部事件（阻塞到迭代器自然结束）。 */
async function collect(iterable: AsyncIterable<ClientAgentEvent>): Promise<ClientAgentEvent[]> {
  const events: ClientAgentEvent[] = [];
  for await (const ev of iterable) {
    events.push(ev);
  }
  return events;
}

describe('ThreadChannel 回放与实时分发', () => {
  it('订阅前 publish 的事件按序回放', async () => {
    const ch = new ThreadChannel('t', 'r', eventNameOf);
    ch.publish(chunk('a'));
    ch.publish(chunk('b'));
    ch.close(); // 先终止：订阅者回放完 buffer 后按 closed 语义自然结束

    const events = await collect(ch.subscribe());
    expect(events.map((e) => (e.payload as StreamChunkPayload).text)).toEqual(['a', 'b']);
  });

  it('多订阅者各自独立拿完整回放', async () => {
    const ch = new ThreadChannel('t', 'r', eventNameOf);
    ch.publish(chunk('a'));
    ch.publish(chunk('b'));
    ch.close();

    // 两个订阅者都从 buffer 快照回放，互不影响
    const s1 = collect(ch.subscribe());
    const s2 = collect(ch.subscribe());
    const [r1, r2] = await Promise.all([s1, s2]);
    expect(r1.map((e) => (e.payload as StreamChunkPayload).text)).toEqual(['a', 'b']);
    expect(r2.map((e) => (e.payload as StreamChunkPayload).text)).toEqual(['a', 'b']);
  });

  it('回放期间 publish 的事件不丢且序正确（回放→实时）', async () => {
    const ch = new ThreadChannel('t', 'r', eventNameOf);
    ch.publish(chunk('a'));

    const it = ch.subscribe()[Symbol.asyncIterator]();
    // 首帧回放 'a'，同时 publish 'b'（进 pending）
    const first = await it.next();
    ch.publish(chunk('b'));
    const second = await it.next();
    expect((first.value!.payload as StreamChunkPayload).text).toBe('a');
    expect((second.value!.payload as StreamChunkPayload).text).toBe('b');
    await it.return!();
    ch.close();
  });

  it('subscribe 后、首次 next 前同步 publish 不丢（锁竞态窗口）', async () => {
    const ch = new ThreadChannel('t', 'r', eventNameOf);
    const it = ch.subscribe()[Symbol.asyncIterator]();
    // 快照为空、监听已注册：此事件只能经 pending 送达
    ch.publish(chunk('x'));
    const first = await it.next();
    expect((first.value!.payload as StreamChunkPayload).text).toBe('x');
    await it.return!();
    ch.close();
  });

  it('typed on 收窄：handler 参数为事件名对应的判别成员', () => {
    const ch = new ThreadChannel('t', 'r', eventNameOf);
    ch.on(ClientAgentEventType.END, (ev) => {
      expectTypeOf(ev).toEqualTypeOf<EndEvent>();
    });
    ch.on(ClientAgentEventType.STREAM_CHUNK, (ev) => {
      expectTypeOf(ev.payload).toEqualTypeOf<StreamChunkPayload>();
    });
    ch.close();
  });
});

describe('ThreadChannel buffer 裁剪', () => {
  it('超限时丢弃最旧的非关键帧，关键帧永不丢', async () => {
    const ch = new ThreadChannel('t', 'r', eventNameOf, { bufferMax: 4 });
    // 满 4 条后每次 publish 挤掉最旧的一个普通帧：a、b 依次被挤；
    // 关键帧 START / HUMAN_INTERRUPT 在裁剪循环里被跳过，永不丢
    ch.publish(startEvent());
    ch.publish(chunk('a'));
    ch.publish(chunk('b'));
    ch.publish(chunk('c'));
    ch.publish(interruptEvent()); // 挤掉 'a'
    ch.publish(chunk('d')); // 挤掉 'b'
    ch.close();

    const events = await collect(ch.subscribe());
    const texts = events
      .filter((e) => e.eventType === ClientAgentEventType.STREAM_CHUNK)
      .map((e) => (e.payload as StreamChunkPayload).text);
    expect(texts).toEqual(['c', 'd']);
    expect(events.some((e) => e.eventType === ClientAgentEventType.START)).toBe(true);
    expect(events.some((e) => e.eventType === ClientAgentEventType.HUMAN_INTERRUPT)).toBe(true);
  });
});

describe('ThreadChannel 终止语义', () => {
  it('publish(END) 后 channel 关闭，后续 publish no-op', async () => {
    const ch = new ThreadChannel('t', 'r', eventNameOf);
    const received: ClientAgentEvent[] = [];
    const collecting = (async () => {
      for await (const ev of ch.subscribe()) received.push(ev);
    })();

    ch.publish(chunk('a'));
    ch.publish(endEvent());
    await collecting;

    expect(ch.isClosed()).toBe(true);
    const before = received.length;
    ch.publish(chunk('after-end')); // no-op
    expect(received.length).toBe(before);
  });

  it('close()（无 END）唤醒挂起的 next() 返回 done，且不向订阅者注入 system END', async () => {
    const ch = new ThreadChannel('t', 'r', eventNameOf);
    const events = collect(ch.subscribe());
    const it = ch.subscribe()[Symbol.asyncIterator]();

    const pendingNext = it.next(); // 无历史、无实时、未关闭 → 挂起
    ch.close();
    await expect(pendingNext).resolves.toEqual({ value: undefined, done: true });

    const collected = await events;
    expect(collected.some((e) => e.agentId === 'system')).toBe(false);
  });

  it('publish(ERROR) 在无订阅者时不抛异常（error 事件名 no-op 常驻监听）', () => {
    const ch = new ThreadChannel('t', 'r', eventNameOf);
    expect(() => ch.publish(errorEvent(false))).not.toThrow();
    ch.close();
  });

  it('iterator.return() 清理监听器（各事件名 listenerCount 回到基线）', async () => {
    const ch = new ThreadChannel('t', 'r', eventNameOf);
    const baseline = ch.listenerCount(ClientAgentEventType.STREAM_CHUNK);
    // 监听注册发生在 subscribe() 内（与快照同一同步段），迭代前即生效
    const it = ch.subscribe()[Symbol.asyncIterator]();
    expect(ch.listenerCount(ClientAgentEventType.STREAM_CHUNK)).toBe(baseline + 1);

    await it.return!();
    expect(ch.listenerCount(ClientAgentEventType.STREAM_CHUNK)).toBe(baseline);
    // 重复 return 无害
    await expect(it.return!()).resolves.toEqual({ value: undefined, done: true });
    ch.close();
  });
});

describe('StreamBridge 通道管理', () => {
  it('channel 同 key 幂等、不同 key 隔离', () => {
    const bridge = new StreamBridge<ClientAgentEvent>(eventNameOf);
    const a1 = bridge.channel('t1', 'r1');
    const a2 = bridge.channel('t1', 'r1');
    const b = bridge.channel('t1', 'r2');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(bridge.size()).toBe(2);
  });

  it('drop 关闭旧 channel 并清除；重新 channel 得到新实例', () => {
    const bridge = new StreamBridge<ClientAgentEvent>(eventNameOf);
    const old = bridge.channel('t1', 'r1');
    bridge.drop('t1', 'r1');
    expect(old.isClosed()).toBe(true);
    expect(bridge.size()).toBe(0);

    const fresh = bridge.channel('t1', 'r1');
    expect(fresh).not.toBe(old);
    expect(fresh.isClosed()).toBe(false);
  });
});
