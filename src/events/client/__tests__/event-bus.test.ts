import { describe, expect, it, vi } from 'vitest';

import {
  ClientAgentEventType,
  createClientAgentEvent,
  type ClientAgentEvent,
} from '../../protocol/client-event';
import { EventBus, type RoutedClientAgentEvent } from '../event-bus';

function routed(event: ClientAgentEvent, sessionId = 's1', streamId = 1): RoutedClientAgentEvent {
  return { ...event, sessionId, streamId };
}

function chunkEvent(text: string): ClientAgentEvent {
  return createClientAgentEvent(ClientAgentEventType.STREAM_CHUNK, 'lead', { text });
}

/** EventBus handler 载荷是联合类型，取 stream_chunk 的 text 需按判别字段收窄。 */
function textOf(e: RoutedClientAgentEvent): string | undefined {
  return e.eventType === ClientAgentEventType.STREAM_CHUNK ? e.payload.text : undefined;
}

function errorEvent(): ClientAgentEvent {
  return createClientAgentEvent(ClientAgentEventType.ERROR, 'lead', {
    errorCode: 'TEST_ERROR',
    errorMessage: 'boom',
    recoverable: false,
  });
}

describe('EventBus（官方 EventEmitter 包装）', () => {
  it('on 后 emit 收到事件；unsubscribe 生效且重复调用无害', () => {
    const bus = new EventBus();
    const received: string[] = [];
    const off = bus.on(ClientAgentEventType.STREAM_CHUNK, (e) => received.push(textOf(e) ?? ''));

    bus.emit(routed(chunkEvent('a')));
    expect(received).toEqual(['a']);

    off();
    off(); // 重复 unsubscribe 无害
    bus.emit(routed(chunkEvent('b')));
    expect(received).toEqual(['a']);
  });

  it('同 type 多 handler 全收到；handler 内 off 自身不影响其余 handler（快照迭代）', () => {
    const bus = new EventBus();
    const received: string[] = [];
    const offH2: { off?: () => void } = {};
    bus.on(ClientAgentEventType.STREAM_CHUNK, (e) => {
      received.push(`h1:${textOf(e)}`);
      offH2.off?.(); // 在派发过程中移除 h2
    });
    offH2.off = bus.on(ClientAgentEventType.STREAM_CHUNK, (e) => received.push(`h2:${textOf(e)}`));

    bus.emit(routed(chunkEvent('a')));
    // h2 在本轮快照中已被拷贝，仍会收到；但之后已反注册
    expect(received).toEqual(['h1:a', 'h2:a']);

    bus.emit(routed(chunkEvent('b')));
    expect(received).toEqual(['h1:a', 'h2:a', 'h1:b']);
  });

  it('emit 期间新增的订阅者本轮不触发、下轮触发', () => {
    const bus = new EventBus();
    const received: string[] = [];
    let added = false;
    bus.on(ClientAgentEventType.STREAM_CHUNK, () => {
      if (!added) {
        added = true;
        bus.on(ClientAgentEventType.STREAM_CHUNK, (e) => received.push(`late:${textOf(e)}`));
      }
      received.push('first');
    });

    bus.emit(routed(chunkEvent('a')));
    expect(received).toEqual(['first']);
    bus.emit(routed(chunkEvent('b')));
    expect(received).toEqual(['first', 'first', 'late:b']);
  });

  it('通配 * 订阅收到所有事件，且晚于同类型精确订阅者', () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on(ClientAgentEventType.STREAM_CHUNK, () => order.push('exact'));
    bus.on('*', (e) => order.push(`wild:${e.eventType}`));

    bus.emit(routed(chunkEvent('a')));
    expect(order).toEqual(['exact', 'wild:stream_chunk']);
  });

  it('handler 抛异常被隔离：console.error 一次，其余订阅者与通配仍执行', () => {
    const bus = new EventBus();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const received: string[] = [];
    bus.on(ClientAgentEventType.STREAM_CHUNK, () => {
      throw new Error('handler boom');
    });
    bus.on(ClientAgentEventType.STREAM_CHUNK, (e) => received.push(`ok:${textOf(e)}`));
    bus.on('*', () => received.push('wild'));

    expect(() => bus.emit(routed(chunkEvent('a')))).not.toThrow();
    expect(received).toEqual(['ok:a', 'wild']);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('once 触发一次即自动移除；触发前手动 off 也生效', () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.once(ClientAgentEventType.STREAM_CHUNK, (e) => received.push(textOf(e) ?? ''));

    bus.emit(routed(chunkEvent('a')));
    bus.emit(routed(chunkEvent('b')));
    expect(received).toEqual(['a']);

    bus.once(ClientAgentEventType.STREAM_CHUNK, (e) => received.push(`once2:${textOf(e)}`));
    // 手动 off 未触发的 once：需要在包装层反查 safe 引用移除
    const off = bus.once(ClientAgentEventType.STREAM_CHUNK, () =>
      received.push('should-never-run'),
    );
    off();
    bus.emit(routed(chunkEvent('c')));
    expect(received).toEqual(['a', 'once2:c']);
  });

  it('仅通配订阅者时 emit ERROR 不抛异常（error 事件名 no-op 常驻监听）', () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.on('*', (e) => received.push(e.eventType));

    expect(() => bus.emit(routed(errorEvent()))).not.toThrow();
    expect(received).toEqual(['error']);
  });

  it('clear 后旧 handler 不触发；clear 后再 emit ERROR 仍不抛（no-op 重建）', () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.on(ClientAgentEventType.STREAM_CHUNK, (e) => received.push(textOf(e) ?? ''));

    bus.clear();
    bus.emit(routed(chunkEvent('a')));
    expect(received).toEqual([]);
    expect(() => bus.emit(routed(errorEvent()))).not.toThrow();
  });

  it('同一 handler 注册两个 type：两个 type 独立 off', () => {
    const bus = new EventBus();
    const received: string[] = [];
    const handler = (e: RoutedClientAgentEvent) => received.push(e.eventType);

    bus.on(ClientAgentEventType.STREAM_CHUNK, handler);
    bus.on(ClientAgentEventType.TOOL_CALL, handler);
    bus.off(ClientAgentEventType.STREAM_CHUNK, handler);

    bus.emit(routed(chunkEvent('a')));
    bus.emit(
      routed(
        createClientAgentEvent(ClientAgentEventType.TOOL_CALL, 'lead', {
          toolCallId: 'tc1',
          toolName: 'search_web',
        }),
      ),
    );
    // stream_chunk 的订阅已移除，tool_call 的仍生效
    expect(received).toEqual(['tool_call']);
  });
});
