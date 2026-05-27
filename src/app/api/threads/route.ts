/**
 * /api/threads
 *  - POST: 创建 thread
 *  - GET:  列表
 *
 * user_id 取自 header `x-user-id`（可空，本期未启用鉴权）
 */

import { NextRequest, NextResponse } from 'next/server';

import type { ThreadStatus } from '@/deerflow-harness';
import { getThreadService } from './_service';

const pickUserId = (req: NextRequest): string | undefined =>
  req.headers.get('x-user-id') ?? undefined;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      thread_id?: string;
      assistant_id?: string;
      display_name?: string;
      metadata?: Record<string, any>;
    };

    const service = await getThreadService();
    const { thread_id } = await service.createThread({
      thread_id: body.thread_id,
      user_id: pickUserId(request),
      assistant_id: body.assistant_id,
      display_name: body.display_name,
      metadata: body.metadata,
    });
    return NextResponse.json({ thread_id }, { status: 201 });
  } catch (e) {
    console.error('[POST /api/threads] error:', e);
    return NextResponse.json(
      { error: 'failed to create thread', message: (e as Error)?.message },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const status = (url.searchParams.get('status') ?? undefined) as ThreadStatus | undefined;

    const service = await getThreadService();
    const list = await service.listThreads({
      user_id: pickUserId(request),
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
      status,
    });
    return NextResponse.json({ data: list }, { status: 200 });
  } catch (e) {
    console.error('[GET /api/threads] error:', e);
    return NextResponse.json(
      { error: 'failed to list threads', message: (e as Error)?.message },
      { status: 500 },
    );
  }
}
