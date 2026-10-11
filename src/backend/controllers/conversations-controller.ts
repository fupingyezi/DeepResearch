/**
 * conversations 域 HTTP 层逻辑（自 src/app/api/conversations/**\/route.ts 抽出）；
 * route.ts 是薄适配器。
 *
 * - POST   /api/conversations/cancel_run：取消该会话正在跑的 run（用户点「停止」）
 * - GET    /api/conversations/get_all_sessions：当前用户全部会话
 * - GET    /api/conversations/history：某会话全部消息（每条携带完整 parts[]）
 * - POST   /api/conversations/update_session：重命名会话
 * - DELETE /api/conversations/update_session：整体删除会话（消息 / 文件 / agent 侧数据）
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { ApiRouteHandler } from '@/backend/http';
import { getConversationService } from '@/backend/services/conversation-service';
import {
  historyQuerySchema,
  sessionIdBodySchema,
  updateSessionBodySchema,
} from '@/backend/validation/schemas';

/**
 * POST /api/conversations/cancel_run —— 取消该会话正在跑的 run（用户点「停止」）。
 *
 * 为什么需要这个接口：前端 abort 只能断掉本地 SSE 连接，而 run 是 fire-and-forget ——
 * 服务端会继续生成、继续烧 token，并在结束时把**完整回答**落库，用户以为已经停住了。
 * 这里把停止动作透传到服务端，真正中断在跑的 run。
 *
 * 语义：幂等。没有在跑的 run（或 thread 记录已不在）一律返回 200 + cancelled: 0，
 * 因为停止按钮只关心「停住」这个结果，不该因为无事可停而报错。
 * cancelled 是取消请求投递数（跨进程部署下为全局语义：送达 owner 即计 1）。
 */
export const cancelRun: ApiRouteHandler<z.infer<typeof sessionIdBodySchema>, undefined> = async ({
  user,
  body,
}) => {
  const { cancelled } = await getConversationService().cancelRun(body.sessionId, user!.id);

  return NextResponse.json({ success: true, cancelled }, { status: 200 });
};

export const listSessions: ApiRouteHandler<undefined, undefined> = async ({ user }) => {
  const data = await getConversationService().listSessions(user!.id);
  return NextResponse.json(
    {
      message: 'Get sessions success!',
      data: data || [],
    },
    { status: 200 },
  );
};

/**
 * GET /api/conversations/history?sessionId=xxx
 *
 * 返回某个 session 的全部消息，每条消息直接携带完整 parts[]，前端无需拼接。
 *
 * Response: { message: string; data: ChatMessageType[] }
 */
export const history: ApiRouteHandler<undefined, z.infer<typeof historyQuerySchema>> = async ({
  user,
  query,
}) => {
  const data = await getConversationService().loadSessionHistory(query.sessionId, user!.id);
  return NextResponse.json(
    {
      message: 'Get history success!',
      data,
    },
    { status: 200 },
  );
};

export const renameSession: ApiRouteHandler<
  z.infer<typeof updateSessionBodySchema>,
  undefined
> = async ({ user, body }) => {
  const data = await getConversationService().renameSession(body.sessionId, user!.id, body.title);

  return NextResponse.json(
    {
      success: true,
      message: 'Session updated successfully',
      data,
    },
    { status: 200 },
  );
};

export const deleteSession: ApiRouteHandler<
  z.infer<typeof sessionIdBodySchema>,
  undefined
> = async ({ user, body }) => {
  const deletedSession = await getConversationService().deleteSession(body.sessionId, user!.id);

  return NextResponse.json(
    {
      success: true,
      message: 'Session and all related data deleted successfully',
      deletedSession,
    },
    { status: 200 },
  );
};
