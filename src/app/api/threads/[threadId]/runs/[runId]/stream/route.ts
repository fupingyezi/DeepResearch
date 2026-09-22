/**
 * /api/threads/[threadId]/runs/[runId]/stream
 *  - GET: SSE 订阅 — 复用 createSseStream + service.subscribe()
 *
 * 与 v2 路由响应同形（text/event-stream，data: <json>\n\n）。
 */

import { createSseStream } from '@/deerflow-harness';
import { withApiHandler } from '@/server/http';
import { getThreadService } from '@/server/wiring';

export const GET = withApiHandler({ auth: 'none' }, async ({ params, request }) => {
  const service = await getThreadService();
  const eventStream = service.subscribe({
    thread_id: params.threadId,
    run_id: params.runId,
  });

  // service.subscribe 返回 AsyncIterable<ClientAgentEvent>，createSseStream 期望的是
  // ClientAgentEventStream（AsyncGenerator）。这里做一层最小包装把 AsyncIterable 适配成
  // AsyncGenerator，零复制零额外解析。
  const adapted = (async function* () {
    for await (const ev of eventStream) yield ev;
  })();

  const stream = createSseStream(request, adapted);

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});
