/**
 * /api/threads/[threadId]/runs/[runId]/stream
 *  - GET: SSE 订阅（断点续读）—— 客户端 SSE 连接中断后凭 last-event-id 重连，
 *    只交付游标之后的事件：START 不重、已收事件不重、END 至多一次。
 *
 * 与 v2 路由响应同形（text/event-stream，`id: <游标>\ndata: <json>\n\n`）。
 *
 * 收尾语义（run-stream-guard）：事件流不以 END 收尾时按 runs 终态 / owner 存活
 * 探测补发 ERROR + END，重连请求不悬挂。
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const forceDynamic = true;

import { ThreadServiceError, createSseStream } from '@/deerflow-harness';
import { withApiHandler } from '@/server/http';
import { guardedStream } from '@/server/services/run-stream-guard';
import { getRunStore, getThreadService } from '@/server/wiring';

export const GET = withApiHandler(
  {
    query: z.object({ 'last-event-id': z.string().max(64).optional() }),
    fallbackMessage: 'failed to subscribe run stream',
  },
  async ({ params, query, user, request }) => {
    // 归属校验：不存在的 run 与别人的 run 一律 404，不泄露存在性
    const runs = getRunStore();
    const run = await runs.get(params.runId);
    if (!run || run.thread_id !== params.threadId || (run.user_id ?? null) !== (user?.id ?? null)) {
      throw new ThreadServiceError(`run not found: ${params.runId}`, 'NOT_FOUND');
    }

    const service = await getThreadService();
    const subscription = service.subscribe({
      thread_id: params.threadId,
      run_id: params.runId,
      fromEventId: query['last-event-id'],
    });

    const stream = createSseStream(request, guardedStream(subscription, runs, params.runId));

    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  },
);
