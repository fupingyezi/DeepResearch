/**
 * GET /api/conversations/history?sessionId=xxx
 *
 * 返回某个 session 的全部消息，每条消息直接携带完整 parts[]，前端无需拼接。
 *
 * Response: { message: string; data: ChatMessageType[] }
 */

import { NextRequest, NextResponse } from 'next/server';

import { loadSessionHistory } from '../_service';
import { getCurrentUser } from '../../auth/_helpers';

export async function GET(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const sessionId = request.nextUrl.searchParams.get('sessionId');
  if (!sessionId) {
    return NextResponse.json({ message: 'sessionId is required' }, { status: 400 });
  }

  try {
    const data = await loadSessionHistory(sessionId, user.id);
    return NextResponse.json(
      {
        message: 'Get history success!',
        data,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('[GET /api/conversations/history] failed:', error);
    return NextResponse.json(
      {
        message: 'Get history failed!',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
