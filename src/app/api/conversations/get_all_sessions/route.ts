import { NextResponse } from 'next/server';

import { withApiHandler } from '@/server/http';
import { getConversationService } from '@/server/services/conversation-service';

export const GET = withApiHandler({ fallbackMessage: 'Get sessions failed!' }, async ({ user }) => {
  const data = await getConversationService().listSessions(user!.id);
  return NextResponse.json(
    {
      message: 'Get sessions success!',
      data: data || [],
    },
    { status: 200 },
  );
});
