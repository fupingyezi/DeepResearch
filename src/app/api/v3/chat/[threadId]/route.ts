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
import { getThreadService, getDeerFlowClientWithModelConfig } from '../../../threads/_service';

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

  // 根据 metadata 中是否有 modelKey 来决定使用哪个客户端
  const hasModelKey = body.metadata?.modelKey && typeof body.metadata.modelKey === 'string';
  let dynamicClient = null;

  if (hasModelKey) {
    // 创建带有指定模型配置的客户端
    dynamicClient = await getDeerFlowClientWithModelConfig(body.metadata);
  }

  // 1) 幂等创建 thread
  try {
    const threadService = await getThreadService();
    await threadService.createThread({
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
    const threadService = await getThreadService();
    const r = await threadService.submitRun({
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

  // 3) 根据是否有指定的模型，选择使用不同的流方式
  let merged: AsyncGenerator<ClientAgentEvent>;

  if (hasModelKey && dynamicClient) {
    // 使用动态客户端直接获取流
    const eventStream = dynamicClient.stream(body.input, threadId, body.metadata);

    merged = (async function* (): AsyncGenerator<ClientAgentEvent> {
      yield createClientAgentEvent(ClientAgentEventType.START, body.agentType ?? 'lead', {
        run_id,
        thread_id: threadId,
      } as never);
      for await (const ev of eventStream) yield ev;
    })();
  } else {
    // 使用标准流订阅
    const service = await getThreadService();
    const subscription = service.subscribe({ thread_id: threadId, run_id });

    merged = (async function* (): AsyncGenerator<ClientAgentEvent> {
      yield createClientAgentEvent(ClientAgentEventType.START, body.agentType ?? 'lead', {
        run_id,
        thread_id: threadId,
      } as never);
      for await (const ev of subscription) yield ev;
    })();
  }

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
