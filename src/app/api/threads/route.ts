/**
 * /api/threads
 *  - POST: 创建 thread
 *  - GET:  列表
 *
 * user_id 取自 header `x-user-id`（可空，本期未启用鉴权）
 */

import { NextResponse } from 'next/server';

import type { ThreadStatus } from '@/deerflow-harness';
import { withApiHandler } from '@/server/http';
import { createThreadSchema, listQuerySchema } from '@/server/validation/schemas';
import { getThreadService } from '@/server/wiring';

export const POST = withApiHandler(
  {
    auth: 'none',
    userIdHeader: 'x-user-id',
    body: createThreadSchema,
    fallbackMessage: 'failed to create thread',
  },
  async ({ userId, body }) => {
    const service = await getThreadService();
    const { thread_id } = await service.createThread({
      thread_id: body.thread_id,
      user_id: userId,
      assistant_id: body.assistant_id,
      display_name: body.display_name,
      metadata: body.metadata,
    });
    return NextResponse.json({ thread_id }, { status: 201 });
  },
);

export const GET = withApiHandler(
  {
    auth: 'none',
    userIdHeader: 'x-user-id',
    query: listQuerySchema,
    fallbackMessage: 'failed to list threads',
  },
  async ({ userId, query }) => {
    const service = await getThreadService();
    const list = await service.listThreads({
      user_id: userId,
      limit: query.limit,
      offset: query.offset,
      status: query.status as ThreadStatus | undefined,
    });
    return NextResponse.json({ data: list }, { status: 200 });
  },
);
