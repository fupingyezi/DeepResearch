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

import { NextResponse } from 'next/server';

import { withApiHandler } from '@/server/http';
import { getConversationService } from '@/server/services/conversation-service';
import { sessionIdBodySchema } from '@/server/validation/schemas';

export const POST = withApiHandler(
  { body: sessionIdBodySchema, fallbackMessage: 'failed to cancel run' },
  async ({ user, body }) => {
    const { cancelled } = await getConversationService().cancelRun(body.sessionId, user!.id);

    return NextResponse.json({ success: true, cancelled }, { status: 200 });
  },
);
