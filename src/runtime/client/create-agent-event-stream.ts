/**
 * createAgentEventStream
 *
 * 前端事件流的统一接收工厂函数：fetch SSE → 分帧 → yield ClientAgentEvent。
 *
 *
 * 错误统一化：
 * - HTTP 非 2xx → yield 一个 `ClientAgentEventType.ERROR` 后 return
 * - fetch 抛错 / AbortSignal 触发 → yield 一个 `ERROR` 后 return（abort 时不视为异常）
 * - JSON 解析失败的单帧由 sse-frame-parser 跳过，不影响整体流
 */

import {
  ClientAgentEventType,
  type ClientAgentEvent,
  type ClientAgentEventStream,
} from '../protocol/client-event';
import { createSseFrameParser } from './sse-frame-parser';

export interface AgentEventStreamOptions {
  /** 后端 SSE endpoint（例如 `/api/threads/:tid/runs/:rid/stream`） */
  endpoint: string;
  /** HTTP 方法，默认 POST。GET 时 body 会被忽略。 */
  method?: 'GET' | 'POST';
  /** POST body（会被 JSON.stringify 后发送） */
  body?: any;
  /** 中断信号 */
  signal?: AbortSignal;
  /** 自定义 headers，会与默认的 Content-Type 合并 */
  headers?: Record<string, string>;
}

function makeErrorEvent(
  errorCode: string,
  errorMessage: string,
  recoverable = false,
): ClientAgentEvent {
  return {
    eventType: ClientAgentEventType.ERROR,
    timestamp: Date.now(),
    agentId: 'client',
    payload: { errorCode, errorMessage, recoverable },
  };
}

/**
 * 创建前端事件流（async generator）。
 *
 * @example
 * ```ts
 * const stream = createAgentEventStream({ endpoint: "/api/v3/chat/${threadId}", body: { input } });
 * for await (const event of stream) {
 *   if (event.eventType === ClientAgentEventType.STREAM_CHUNK) {
 *     console.log(event.payload.text);
 *   }
 * }
 * ```
 */
export async function* createAgentEventStream(
  opts: AgentEventStreamOptions,
): ClientAgentEventStream {
  const { endpoint, body, signal, headers, method = 'POST' } = opts;

  let response: Response;
  try {
    const init: RequestInit = {
      method,
      headers: {
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      // 同源携带 HttpOnly 会话 cookie，后端 getCurrentUser 解析鉴权
      credentials: 'include',
      signal,
    };
    if (method === 'POST') init.body = JSON.stringify(body);
    response = await fetch(endpoint, init);
  } catch (err) {
    // AbortError 不视为异常，但仍以 ERROR 事件统一通知消费者
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err instanceof Error && err.name === 'AbortError'
        ? 'AGENT_STREAM_ABORTED'
        : 'AGENT_STREAM_FETCH_FAILED';
    yield makeErrorEvent(code, message, code === 'AGENT_STREAM_ABORTED');
    return;
  }

  if (!response.ok) {
    yield makeErrorEvent(
      'AGENT_STREAM_HTTP_ERROR',
      `HTTP ${response.status} ${response.statusText}`,
      false,
    );
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    yield makeErrorEvent('AGENT_STREAM_NO_BODY', 'Response body is not readable', false);
    return;
  }

  const decoder = new TextDecoder();
  const parser = createSseFrameParser();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const events = parser.feed(decoder.decode(value, { stream: true }));
      for (const event of events) {
        yield event;
      }
    }
    // 处理流尾残留
    for (const event of parser.flush()) {
      yield event;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err instanceof Error && err.name === 'AbortError'
        ? 'AGENT_STREAM_ABORTED'
        : 'AGENT_STREAM_READ_FAILED';
    yield makeErrorEvent(code, message, code === 'AGENT_STREAM_ABORTED');
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // reader 可能已被取消，忽略
    }
  }
}
