/**
 * createSseStream
 *
 * 后端 SSE 输出 writer：接收带游标的 SseStreamEvent 异步生成器。
 *
 * - 带 eventId 的帧序列化为 `id: <eventId>\ndata: <JSON>\n\n`——客户端把最后
 *   收到的 id 作为断点续读游标（重连路由的 last-event-id）；无 id 的帧
 *   （如 START）只发 `data:` 行，不更新游标
 * - 错误回退：流内部抛错 → enqueue 一个 ClientAgentEventType.ERROR 事件（无 id），
 *   再 close；request.signal abort → 静默停止，不再 enqueue。
 */

import { ClientAgentEventType, createClientAgentEvent, type SseStreamEvents } from './client-event';

export function createSseStream(request: Request, eventStream: SseStreamEvents): ReadableStream {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      let aborted = false;

      const cleanup = () => {
        aborted = true;
      };
      request.signal?.addEventListener('abort', cleanup);

      const safeEnqueue = (frame: { eventId?: string; event: unknown }): boolean => {
        if (aborted) return false;
        try {
          const idLine = frame.eventId ? `id: ${frame.eventId}\n` : '';
          controller.enqueue(encoder.encode(`${idLine}data: ${JSON.stringify(frame.event)}\n\n`));
          return true;
        } catch (e) {
          console.error('[createSseStream] enqueue failed:', e);
          aborted = true;
          return false;
        }
      };

      try {
        for await (const frame of eventStream) {
          if (aborted) break;
          if (!safeEnqueue(frame)) break;
        }
      } catch (error) {
        if (!aborted) {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[createSseStream] stream error:', message);
          safeEnqueue({
            event: createClientAgentEvent(ClientAgentEventType.ERROR, 'system', {
              errorCode: 'SSE_STREAM_ERROR',
              errorMessage: message || 'SSE stream error occurred',
              recoverable: false,
            }),
          });
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
