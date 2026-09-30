import { describe, expect, it, vi } from 'vitest';

import { ClientAgentEventType, createClientAgentEvent } from '../../protocol/client-event';
import { createSseFrameParser } from '../sse-frame-parser';

function frame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function chunkEvent(text: string) {
  return createClientAgentEvent(ClientAgentEventType.STREAM_CHUNK, 'lead', { text });
}

describe('createSseFrameParser', () => {
  it('单 chunk 多帧一次解析', () => {
    const parser = createSseFrameParser();
    const events = parser.feed(frame(chunkEvent('a')) + frame(chunkEvent('b')));
    expect(events).toHaveLength(2);
    expect(events[0].eventType).toBe(ClientAgentEventType.STREAM_CHUNK);
    expect(events[1].eventType).toBe(ClientAgentEventType.STREAM_CHUNK);
  });

  it('帧跨 chunk 边界（data: 前缀被截断）分两次 feed 正确拼出', () => {
    const parser = createSseFrameParser();
    const full = frame(chunkEvent('a'));
    const cut = full.indexOf(':') + 1; // 在 'data' 与 ': ' 之间截断

    expect(parser.feed(full.slice(0, cut))).toEqual([]);
    const events = parser.feed(full.slice(cut));
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe(ClientAgentEventType.STREAM_CHUNK);
  });

  it('非 data: 行（event:/id:/空行）被忽略', () => {
    const parser = createSseFrameParser();
    const events = parser.feed(
      `event: message\nid: 1\n\n` + `retry: 3000\n\n` + frame(chunkEvent('a')),
    );
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe(ClientAgentEventType.STREAM_CHUNK);
  });

  it('非法 JSON 帧：跳过且不阻塞后续帧', () => {
    const parser = createSseFrameParser();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const events = parser.feed(`data: {not-json}\n\n` + frame(chunkEvent('a')));
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe(ClientAgentEventType.STREAM_CHUNK);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('flush 吐出残留帧；空 buffer flush 返回 []', () => {
    const parser = createSseFrameParser();
    const full = frame(chunkEvent('a'));
    // feed 一半（无 \n\n 结尾），残留进 buffer
    parser.feed(full.slice(0, full.length - 2));
    const events = parser.flush();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe(ClientAgentEventType.STREAM_CHUNK);
    expect(parser.flush()).toEqual([]);
  });

  it('空帧与空 data 行不产出事件', () => {
    const parser = createSseFrameParser();
    const events = parser.feed(`\n\n` + `data: \n\n` + `data:\n\n`);
    expect(events).toEqual([]);
  });
});
