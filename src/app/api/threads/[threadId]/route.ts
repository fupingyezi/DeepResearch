/**
 * /api/threads/[threadId]
 *  - GET:    读 meta（?include=checkpoint 时同时返回当前 checkpoint）
 *  - DELETE: 删除 thread + 清理 checkpoint
 */

import { NextRequest, NextResponse } from 'next/server';

import { getThreadService } from '../_service';

const pickUserId = (req: NextRequest): string | undefined =>
  req.headers.get('x-user-id') ?? undefined;

export async function GET(request: NextRequest, ctx: { params: { threadId: string } }) {
  try {
    const url = new URL(request.url);
    const includeCheckpoint = url.searchParams.get('include') === 'checkpoint';

    const service = await getThreadService();
    const result = await service.getThread({
      thread_id: ctx.params.threadId,
      user_id: pickUserId(request),
      includeCheckpoint,
    });
    if (!result) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    console.error('[GET /api/threads/:id] error:', e);
    return NextResponse.json(
      { error: 'failed to get thread', message: (e as Error)?.message },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest, ctx: { params: { threadId: string } }) {
  try {
    const service = await getThreadService();
    await service.deleteThread({
      thread_id: ctx.params.threadId,
      user_id: pickUserId(request),
    });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e) {
    console.error('[DELETE /api/threads/:id] error:', e);
    return NextResponse.json(
      { error: 'failed to delete thread', message: (e as Error)?.message },
      { status: 500 },
    );
  }
}
