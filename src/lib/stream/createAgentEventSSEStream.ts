/**
 * createAgentEventSSEStream - v2 统一 SSE 传输层
 *
 * 接收 AgentEvent 异步生成器，自动将事件序列化为 SSE data: 行。
 * 每个事件包含 eventType 字段，前端可据此进行统一事件分发。
 */

import { AgentEvent, AgentEventStream } from "@/types/agentEvent";

/**
 * 创建基于 AgentEvent 的 SSE 流
 *
 * @param request - HTTP 请求对象（用于监听 abort 信号）
 * @param eventStream - AgentEvent 异步生成器
 * @returns ReadableStream - SSE 格式的可读流
 */
export function createAgentEventSSEStream(
  request: Request,
  eventStream: AgentEventStream,
): ReadableStream {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      let aborted = false;

      const cleanup = () => {
        aborted = true;
      };
      request.signal?.addEventListener("abort", cleanup);

      const safeEnqueue = (data: any): boolean => {
        if (aborted) return false;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
          );
          return true;
        } catch (e) {
          console.error("SSE enqueue failed", e);
          aborted = true;
          return false;
        }
      };

      try {
        for await (const event of eventStream) {
          if (aborted) break;

          // 直接将 AgentEvent 序列化为 SSE data 行
          if (!safeEnqueue(event)) break;
        }
      } catch (error: any) {
        if (!aborted) {
          safeEnqueue({
            eventType: "error",
            timestamp: Date.now(),
            agentId: "system",
            payload: {
              errorCode: "SSEStreamError",
              errorMessage: error.message || "SSE stream error occurred",
              recoverable: false,
            },
          });
        }
      } finally {
        request.signal?.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // controller 可能已关闭
        }
      }
    },
  });
}
