/**
 * createSseStream
 *
 * 后端 SSE 输出 writer：接收 ClientAgentEvent 异步生成器，
 * 序列化为 `data: <JSON>\n\n` 格式的 ReadableStream。
 *
 * 错误回退：
 * - 流内部抛错 → enqueue 一个 ClientAgentEventType.ERROR 事件，再 close。
 * - request.signal abort → 静默停止，不再 enqueue。
 */

import {
  ClientAgentEventType,
  createClientAgentEvent,
  type ClientAgentEventStream,
} from './client-event';

export function createSseStream(
  request: Request,
  eventStream: ClientAgentEventStream,
): ReadableStream {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      let aborted = false;

      const cleanup = () => {
        aborted = true;
      };
      request.signal?.addEventListener('abort', cleanup);

      const safeEnqueue = (data: unknown): boolean => {
        if (aborted) return false;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          return true;
        } catch (e) {
          console.error('[createSseStream] enqueue failed:', e);
          aborted = true;
          return false;
        }
      };

      try {
        for await (const event of eventStream) {
          if (aborted) break;
          if (!safeEnqueue(event)) break;
        }
      } catch (error) {
        if (!aborted) {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[createSseStream] stream error:', message);
          safeEnqueue(
            createClientAgentEvent(ClientAgentEventType.ERROR, 'system', {
              errorCode: 'SSE_STREAM_ERROR',
              errorMessage: message || 'SSE stream error occurred',
              recoverable: false,
            }),
          );
        }
      } finally {
        request.signal?.removeEventListener('abort', cleanup);
        try {
          controller.close();
        } catch {
          // controller 可能已关闭，忽略
        }
      }
    },
  });
}
