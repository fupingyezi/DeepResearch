/**
 * /api/threads/[threadId]
 *  - GET:    读 meta（?include=checkpoint 时同时返回当前 checkpoint）
 *  - DELETE: 删除 thread + 清理 checkpoint
 */

import { NextResponse } from 'next/server';

import { jsonError, withApiHandler } from '@/server/http';
import { getThreadQuerySchema } from '@/server/validation/schemas';
import { getThreadService } from '@/server/wiring';

export const GET = withApiHandler(
  {
    auth: 'none',
    userIdHeader: 'x-user-id',
    query: getThreadQuerySchema,
    fallbackMessage: 'failed to get thread',
  },
  async ({ userId, query, params }) => {
    const service = await getThreadService();
    const result = await service.getThread({
      thread_id: params.threadId,
      user_id: userId,
      includeCheckpoint: query.include === 'checkpoint',
    });
    if (!result) return jsonError('NOT_FOUND', 'not found', 404);
    return NextResponse.json(result, { status: 200 });
  },
);

export const DELETE = withApiHandler(
  { auth: 'none', userIdHeader: 'x-user-id', fallbackMessage: 'failed to delete thread' },
  async ({ userId, params }) => {
    const service = await getThreadService();
    await service.deleteThread({
      thread_id: params.threadId,
      user_id: userId,
    });
    return NextResponse.json({ ok: true }, { status: 200 });
  },
);
