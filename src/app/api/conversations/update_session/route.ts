import { NextResponse } from 'next/server';

import { withApiHandler } from '@/server/http';
import { getConversationService } from '@/server/services/conversation-service';
import { sessionIdBodySchema, updateSessionBodySchema } from '@/server/validation/schemas';

export { OPTIONS } from '@/server/http/preflight';

export const POST = withApiHandler(
  { body: updateSessionBodySchema, fallbackMessage: 'Failed to update session' },
  async ({ user, body }) => {
    const data = await getConversationService().renameSession(body.sessionId, user!.id, body.title);

    return NextResponse.json(
      {
        success: true,
        message: 'Session updated successfully',
        data,
      },
      { status: 200 },
    );
  },
);

export const DELETE = withApiHandler(
  { body: sessionIdBodySchema, fallbackMessage: 'Failed to delete session' },
  async ({ user, body }) => {
    const deletedSession = await getConversationService().deleteSession(body.sessionId, user!.id);

    return NextResponse.json(
      {
        success: true,
        message: 'Session and all related data deleted successfully',
        deletedSession,
      },
      { status: 200 },
    );
  },
);
