/**
 * /api/threads/[threadId]/runs
 *  - POST: submitRun（fire-and-forget）→ { run_id }
 *  - GET:  列出 thread 的 runs
 */

import { NextRequest, NextResponse } from 'next/server';

import type { RunStatus } from '@/deerflow-harness';
import { PgRunStore } from '@/deerflow-harness';
import { getThreadService } from '../../_service';

const pickUserId = (req: NextRequest): string | undefined =>
  req.headers.get('x-user-id') ?? undefined;

export async function POST(
  request: NextRequest,
  ctx: { params: { threadId: string } },
) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      input?: string;
      metadata?: Record<string, unknown>;
    };
    if (!body.input || typeof body.input !== 'string') {
      return NextResponse.json({ error: 'missing input' }, { status: 400 });
    }

    const service = await getThreadService();
    const { run_id } = await service.submitRun({
      thread_id: ctx.params.threadId,
      user_id: pickUserId(request),
      input: body.input,
      metadata: body.metadata,
    });
    return NextResponse.json({ run_id }, { status: 202 });
  } catch (e) {
    const code = (e as Error & { code?: string })?.code;
    const status = code === 'NOT_FOUND' ? 404 : 500;
    console.error('[POST /api/threads/:id/runs] error:', e);
    return NextResponse.json(
      { error: 'failed to submit run', message: (e as Error)?.message },
      { status },
    );
  }
}

export async function GET(
  request: NextRequest,
  ctx: { params: { threadId: string } },
) {
  try {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const status = (url.searchParams.get('status') ?? undefined) as RunStatus | undefined;

    // 复用同一个 PgRunStore；轻量直读，避免再 await service 装配开销
    const runs = new PgRunStore();
    const data = await runs.listByThread(ctx.params.threadId, {
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
      status,
    });
    return NextResponse.json({ data }, { status: 200 });
  } catch (e) {
    console.error('[GET /api/threads/:id/runs] error:', e);
    return NextResponse.json(
      { error: 'failed to list runs', message: (e as Error)?.message },
      { status: 500 },
    );
  }
}
