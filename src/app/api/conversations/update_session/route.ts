import { NextRequest, NextResponse } from 'next/server';

import { getCurrentUser, toHttpError } from '@/server/http';
import { getConversationService } from '@/server/services/conversation-service';
import { parseJsonBody } from '@/server/validation';
import { sessionIdBodySchema, updateSessionBodySchema } from '@/server/validation/schemas';

export async function POST(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const parsed = await parseJsonBody(request, updateSessionBodySchema);
  if (!parsed.ok) return parsed.response;

  try {
    const data = await getConversationService().renameSession(
      parsed.data.sessionId,
      user.id,
      parsed.data.title,
    );

    return NextResponse.json(
      {
        success: true,
        message: 'Session updated successfully',
        data,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('Update session error:', error);
    return toHttpError(error, 'Failed to update session');
  }
}

export async function DELETE(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const parsed = await parseJsonBody(request, sessionIdBodySchema);
  if (!parsed.ok) return parsed.response;

  try {
    const deletedSession = await getConversationService().deleteSession(
      parsed.data.sessionId,
      user.id,
    );

    return NextResponse.json(
      {
        success: true,
        message: 'Session and all related data deleted successfully',
        deletedSession,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('Delete session error:', error);
    return toHttpError(error, 'Failed to delete session');
  }
}
