/**
 * /api/v3/chat/[threadId]
 *
 * Request：
 *   POST application/json
 *   { input, agentType?, displayName?, metadata? }
 *
 * Response：
 *   text/event-stream，载荷为 ClientAgentEvent
 */

import { NextRequest } from 'next/server';

import {
  ClientAgentEventType,
  createClientAgentEvent,
  createSseStream,
  type ClientAgentEvent,
} from '@/deerflow-harness';
import { getThreadService } from '../../../threads/_service';

const pickUserId = (req: NextRequest): string | undefined =>
  req.headers.get('x-user-id') ?? undefined;

interface ChatBody {
  input?: string;
  agentType?: string;
  displayName?: string;
  metadata?: Record<string, any>;
}

export async function POST(
  request: NextRequest,
  ctx: { params: { threadId: string } },
) {
  const { threadId } = ctx.params;
  const user_id = pickUserId(request);

  const body = (await request.json().catch(() => ({}))) as ChatBody;
  if (!body.input || typeof body.input !== 'string') {
    return new Response(
      JSON.stringify({ error: 'missing input' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const service = await getThreadService();

  // 1) 幂等创建 thread
  try {
    await service.createThread({
      thread_id: threadId,
      user_id,
      assistant_id: body.agentType,
      display_name: body.displayName ?? body.input.slice(0, 15) ?? 'New thread',
      metadata: body.metadata,
    });
  } catch (e) {
    console.error('[POST /api/v3/chat/:tid] createThread failed:', e);
    return new Response(
      JSON.stringify({
        error: 'failed to create thread',
        message: (e as Error)?.message,
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // 2) 提交 run（fire-and-forget，立即拿到 run_id）
  let run_id: string;
  try {
    const r = await service.submitRun({
      thread_id: threadId,
      user_id,
      input: body.input,
      metadata: body.metadata,
    });
    run_id = r.run_id;
  } catch (e) {
    const code = (e as Error & { code?: string })?.code;
    const status = code === 'NOT_FOUND' ? 404 : 500;
    console.error('[POST /api/v3/chat/:tid] submitRun failed:', e);
    return new Response(
      JSON.stringify({
        error: 'failed to submit run',
        message: (e as Error)?.message,
      }),
      { status, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // 3) 订阅 stream-bridge，并在最前面注入一个携带 run_id 的 START 帧
  const subscription = service.subscribe({ thread_id: threadId, run_id });

  const merged = (async function* (): AsyncGenerator<ClientAgentEvent> {
    yield createClientAgentEvent(ClientAgentEventType.START, body.agentType ?? 'lead', {
      run_id,
      thread_id: threadId,
    } as never);
    for await (const ev of subscription) yield ev;
  })();

  const stream = createSseStream(request, merged);
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // 暴露 run_id，便于客户端在 fetch 完成 headers 后立即拿到（可选）
      'X-Run-Id': run_id,
    },
  });
}
