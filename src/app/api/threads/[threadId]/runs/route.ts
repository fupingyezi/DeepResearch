/**
 * /api/threads/[threadId]/runs
 *  - POST: submitRun（fire-and-forget）→ { run_id }
 *  - GET:  列出 thread 的 runs
 */

import { NextResponse } from 'next/server';

import type { RunStatus } from '@/deerflow-harness';
import { withApiHandler } from '@/server/http';
import { listQuerySchema, submitRunSchema } from '@/server/validation/schemas';
import { getRunStore, getThreadService } from '@/server/wiring';

export const POST = withApiHandler(
  {
    auth: 'none',
    userIdHeader: 'x-user-id',
    body: submitRunSchema,
    fallbackMessage: 'failed to submit run',
  },
  async ({ userId, body, params }) => {
    const service = await getThreadService();
    const { run_id } = await service.submitRun({
      thread_id: params.threadId,
      user_id: userId,
      input: body.input,
      metadata: body.metadata,
    });
    return NextResponse.json({ run_id }, { status: 202 });
  },
);

export const GET = withApiHandler(
  {
    auth: 'none',
    userIdHeader: 'x-user-id',
    query: listQuerySchema,
    fallbackMessage: 'failed to list runs',
  },
  async ({ query, params }) => {
    // 复用同一个 PgRunStore；轻量直读，避免再 await service 装配开销
    const data = await getRunStore().listByThread(params.threadId, {
      limit: query.limit,
      offset: query.offset,
      status: query.status as RunStatus | undefined,
    });
    return NextResponse.json({ data }, { status: 200 });
  },
);
