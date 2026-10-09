/**
 * /api/threads
 *  - POST: 创建 thread
 *  - GET:  列表
 *
 * cookie 鉴权：user_id 取当前登录用户。x-user-id 透传头已废弃——
 * 无签名、空值放行.
 */

import { NextResponse } from 'next/server';

import type { ThreadStatus } from '@/deerflow-harness';
import { withApiHandler } from '@/server/http';
import { createThreadSchema, listQuerySchema } from '@/server/validation/schemas';
import { getThreadService } from '@/server/wiring';

export const POST = withApiHandler(
  {
    body: createThreadSchema,
    fallbackMessage: 'failed to create thread',
  },
  async ({ user, body }) => {
    const service = await getThreadService();
    const { thread_id } = await service.createThread({
      thread_id: body.thread_id,
      user_id: user!.id,
      assistant_id: body.assistant_id,
      display_name: body.display_name,
      metadata: body.metadata,
    });
    return NextResponse.json({ thread_id }, { status: 201 });
  },
);

export const GET = withApiHandler(
  {
    query: listQuerySchema,
    fallbackMessage: 'failed to list threads',
  },
  async ({ user, query }) => {
    const service = await getThreadService();
    const list = await service.listThreads({
      user_id: user!.id,
      limit: query.limit,
      offset: query.offset,
      status: query.status as ThreadStatus | undefined,
    });
    return NextResponse.json({ data: list }, { status: 200 });
  },
);
