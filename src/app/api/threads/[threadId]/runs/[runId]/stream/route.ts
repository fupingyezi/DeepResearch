/**
 * /api/threads/[threadId]/runs/[runId]/stream
 *  - GET: SSE 订阅（断点续读）—— 客户端 SSE 连接中断后凭 last-event-id 重连，
 *    只交付游标之后的事件：START 不重、已收事件不重、END 至多一次。
 *
 * 与 v2 路由响应同形（text/event-stream，`id: <游标>\ndata: <json>\n\n`）。
 *
 * 终态守卫：事件流不以 END 收尾而 run 已到终态（owner 崩溃的悬挂流 / 内存实现
 * 的已释放通道）时，按 runs 状态补发 ERROR + END，重连请求不悬挂。
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const forceDynamic = true;

import {
  ClientAgentEventType,
  ThreadServiceError,
  createClientAgentEvent,
  createSseStream,
  type SseStreamEvent,
  type StampedClientAgentEvent,
} from '@/deerflow-harness';
import { withApiHandler } from '@/server/http';
import { getRunStore, getThreadService } from '@/server/wiring';

/** 终态轮询间隔：订阅挂起期间定期查 runs 终态，让悬挂流尽快收尾。 */
const TERMINAL_POLL_MS = 5_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 事件流守卫：把「订阅迭代」与「runs 终态探测」合并成一条有序流。 */
async function* guardedStream(
  subscription: AsyncIterable<StampedClientAgentEvent>,
  runs: ReturnType<typeof getRunStore>,
  runId: string,
): AsyncGenerator<SseStreamEvent> {
  let sawEnd = false;
  const it = subscription[Symbol.asyncIterator]();
  // 同一时刻至多挂起一个 next()：终态探测只是插入等待期，不与迭代器并发拉取
  let pending = it.next();
  try {
    for (;;) {
      const outcome = await Promise.race([
        pending,
        delay(TERMINAL_POLL_MS).then(() => 'timeout' as const),
      ]);
      if (outcome === 'timeout') {
        const run = await runs.get(runId);
        if (run && run.status !== 'running') break; // run 已终态：补尾帧收束
        continue;
      }
      if (outcome.done) break;
      yield { eventId: outcome.value.eventId, event: outcome.value.event };
      if (outcome.value.event.eventType === ClientAgentEventType.END) {
        sawEnd = true;
        break;
      }
      pending = it.next();
    }
  } finally {
    // 收束后释放订阅：跨进程订阅挂起在 XREAD BLOCK 上，不显式 return 会泄漏连接
    pending.catch(() => undefined);
    await it.return?.().catch(() => undefined);
  }

  if (!sawEnd) {
    // 未收到 END：run 终态 / 流已过期 / owner 死亡。runs 是共享真相源，按其终态收束
    const run = await runs.get(runId);
    if (run && run.status !== 'running') {
      yield {
        event: createClientAgentEvent(ClientAgentEventType.ERROR, 'system', {
          errorCode: 'RUN_STREAM_INCOMPLETE',
          errorMessage: '事件流中断且 run 已结束：后续内容请刷新对话查看落库结果。',
          recoverable: false,
        }),
      };
      yield { event: createClientAgentEvent(ClientAgentEventType.END, 'system', {} as never) };
    }
  }
}

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
