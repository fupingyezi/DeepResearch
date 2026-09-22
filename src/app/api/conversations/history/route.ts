/**
 * GET /api/conversations/history?sessionId=xxx
 *
 * 返回某个 session 的全部消息，每条消息直接携带完整 parts[]，前端无需拼接。
 *
 * Response: { message: string; data: ChatMessageType[] }
 */

import { NextResponse } from 'next/server';

import { withApiHandler } from '@/server/http';
import { getConversationService } from '@/server/services/conversation-service';
import { historyQuerySchema } from '@/server/validation/schemas';

export const GET = withApiHandler(
  { query: historyQuerySchema, fallbackMessage: 'Get history failed!' },
  async ({ user, query }) => {
    const data = await getConversationService().loadSessionHistory(query.sessionId, user!.id);
    return NextResponse.json(
      {
        message: 'Get history success!',
        data,
      },
      { status: 200 },
    );
  },
);
