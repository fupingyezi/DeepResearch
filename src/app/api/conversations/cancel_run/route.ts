/**
 * POST /api/conversations/cancel_run —— 取消该会话正在跑的 run（用户点「停止」）。
 *
 * 为什么需要这个接口：前端 abort 只能断掉本地 SSE 连接，而 run 是 fire-and-forget ——
 * 服务端会继续生成、继续烧 token，并在结束时把**完整回答**落库，用户以为已经停住了。
 * 这里把停止动作透传到服务端，真正中断在跑的 run。
 *
 * 语义：幂等。没有在跑的 run（或 thread 记录已不在）一律返回 200 + cancelled: 0，
 * 因为停止按钮只关心「停住」这个结果，不该因为无事可停而报错。
 */

import { NextRequest, NextResponse } from 'next/server';

import { query } from '@/lib';
import { ThreadServiceError } from '@/deerflow-harness';
import { getCurrentUser } from '../../auth/_helpers';
import { getThreadService } from '../../threads/_service';

export async function POST(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  try {
    const { sessionId } = await request.json();

    if (!sessionId) {
      return NextResponse.json({ error: 'Missing required field: sessionId' }, { status: 400 });
    }

    // 归属校验：chat_session 是 app 侧的真相源，只允许取消自己的会话
    const owned = await query(
      `select 1 from chat_session where id = $1 and user_id = $2 limit 1;`,
      [sessionId, user.id],
    );
    if (owned.rows.length === 0) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const threadService = await getThreadService();
    const { cancelled } = await threadService.cancelRun({
      thread_id: sessionId,
      user_id: user.id,
    });

    return NextResponse.json({ success: true, cancelled }, { status: 200 });
  } catch (error) {
    // thread 记录缺失（会话有、harness 侧没有）→ 没什么可停，照常返回
    if (error instanceof ThreadServiceError && error.code === 'NOT_FOUND') {
      return NextResponse.json({ success: true, cancelled: 0 }, { status: 200 });
    }
    console.error('[POST /api/conversations/cancel_run] error:', error);
    return NextResponse.json(
      {
        error: 'failed to cancel run',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
