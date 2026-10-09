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
    query: getThreadQuerySchema,
    fallbackMessage: 'failed to get thread',
  },
  async ({ user, query, params }) => {
    const service = await getThreadService();
    const result = await service.getThread({
      thread_id: params.threadId,
      user_id: user!.id,
      includeCheckpoint: query.include === 'checkpoint',
    });
    if (!result) return jsonError('NOT_FOUND', 'not found', 404);
    return NextResponse.json(result, { status: 200 });
  },
);

export const DELETE = withApiHandler(
  { fallbackMessage: 'failed to delete thread' },
  async ({ user, params }) => {
    const service = await getThreadService();
    await service.deleteThread({
      thread_id: params.threadId,
      user_id: user!.id,
    });
    return NextResponse.json({ ok: true }, { status: 200 });
  },
);
