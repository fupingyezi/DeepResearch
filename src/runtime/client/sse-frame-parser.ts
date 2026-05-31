/**
 * SSE 帧解析器
 *
 * 处理跨 chunk 的不完整数据行，按 `\n\n` 切帧、按 `data: ` 前缀提取 JSON。
 * 内部维护 buffer，已 feed 但尚未形成完整帧的内容会被保留至下次 feed 或 flush。
 *
 * 解析失败的帧会 console.error 并跳过，不阻塞后续帧。
 */

import type { ClientAgentEvent } from '../protocol/client-event';

export interface SseFrameParser {
  /**
   * 喂入新的字符串 chunk，返回本次能完整解析出的事件数组。
   * 残留的不完整数据保留在内部 buffer 中。
   */
  feed(chunk: string): ClientAgentEvent[];
  /**
   * 流结束时调用，处理 buffer 中可能残留的最后一帧。
   */
  flush(): ClientAgentEvent[];
}

/**
 * 创建 SSE 帧解析器实例。
 *
 * 每个流应该独占一个 parser 实例，避免不同流之间共享 buffer 状态。
 */
export function createSseFrameParser(): SseFrameParser {
  let buffer = '';

  function parseFrame(frame: string): ClientAgentEvent | null {
    const lines = frame.split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const dataStr = line.slice(6);
      if (!dataStr) continue;
      try {
        return JSON.parse(dataStr) as ClientAgentEvent;
      } catch (err) {
        console.error('[sse-frame-parser] JSON parse failed:', err);
        return null;
      }
    }
    return null;
  }

  return {
    feed(chunk: string): ClientAgentEvent[] {
      buffer += chunk;
      const events: ClientAgentEvent[] = [];
      const frames = buffer.split('\n\n');
      // 最后一个元素可能是不完整的，保留至下次 feed
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const event = parseFrame(frame);
        if (event) events.push(event);
      }
      return events;
    },
    flush(): ClientAgentEvent[] {
      if (!buffer.trim()) return [];
      const event = parseFrame(buffer);
      buffer = '';
      return event ? [event] : [];
    },
  };
}
