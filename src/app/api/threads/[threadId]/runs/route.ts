/**
 * /api/threads/[threadId]/runs
 *  - POST: submitRun（fire-and-forget）→ { run_id }
 *  - GET:  列出 thread 的 runs
 */

import { NextRequest, NextResponse } from 'next/server';

import type { RunStatus } from '@/deerflow-harness';
import { toHttpError } from '@/server/http';
import { parseJsonBody } from '@/server/validation';
import { submitRunSchema } from '@/server/validation/schemas';
import { getRunStore, getThreadService } from '@/server/wiring';

const pickUserId = (req: NextRequest): string | undefined =>
  req.headers.get('x-user-id') ?? undefined;

export async function POST(request: NextRequest, ctx: { params: { threadId: string } }) {
  const parsed = await parseJsonBody(request, submitRunSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const service = await getThreadService();
    const { run_id } = await service.submitRun({
      thread_id: ctx.params.threadId,
      user_id: pickUserId(request),
      input: parsed.data.input,
      metadata: parsed.data.metadata,
    });
    return NextResponse.json({ run_id }, { status: 202 });
  } catch (e) {
    console.error('[POST /api/threads/:id/runs] error:', e);
    return toHttpError(e, 'failed to submit run');
  }
}

export async function GET(request: NextRequest, ctx: { params: { threadId: string } }) {
  try {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const status = (url.searchParams.get('status') ?? undefined) as RunStatus | undefined;

    // 复用同一个 PgRunStore；轻量直读，避免再 await service 装配开销
    const data = await getRunStore().listByThread(ctx.params.threadId, {
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
      status,
    });
    return NextResponse.json({ data }, { status: 200 });
  } catch (e) {
    console.error('[GET /api/threads/:id/runs] error:', e);
    return toHttpError(e, 'failed to list runs');
  }
}
