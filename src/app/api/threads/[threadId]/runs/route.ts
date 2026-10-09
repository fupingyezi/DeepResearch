/**
 * /api/threads/[threadId]/runs
 *  - POST: submitRun（fire-and-forget）→ { run_id }
 *  - GET:  列出 thread 的 runs
 */

import { NextResponse } from 'next/server';

import type { RunStatus } from '@/deerflow-harness';
import { withApiHandler, jsonError } from '@/server/http';
import { listQuerySchema, submitRunSchema } from '@/server/validation/schemas';
import { getRunStore, getThreadService } from '@/server/wiring';

export const POST = withApiHandler(
  {
    body: submitRunSchema,
    fallbackMessage: 'failed to submit run',
  },
  async ({ user, body, params }) => {
    const service = await getThreadService();
    const { run_id } = await service.submitRun({
      thread_id: params.threadId,
      user_id: user!.id,
      input: body.input,
      metadata: body.metadata,
    });
    return NextResponse.json({ run_id }, { status: 202 });
  },
);

export const GET = withApiHandler(
  {
    query: listQuerySchema,
    fallbackMessage: 'failed to list runs',
  },
  async ({ user, query, params }) => {
    const service = await getThreadService();
    const thread = await service.getThread({ thread_id: params.threadId, user_id: user!.id });
    if (!thread) return jsonError('NOT_FOUND', 'not found', 404);
    // 归属已在上一步经 service.getThread 校验；列表本身复用同一个 PgRunStore 轻量直读
    const data = await getRunStore().listByThread(params.threadId, {
      limit: query.limit,
      offset: query.offset,
      status: query.status as RunStatus | undefined,
    });
    return NextResponse.json({ data }, { status: 200 });
  },
);
