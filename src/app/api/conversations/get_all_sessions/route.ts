import { NextRequest, NextResponse } from 'next/server';

import { getCurrentUser, toHttpError } from '@/server/http';
import { getConversationService } from '@/server/services/conversation-service';

export async function GET(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  try {
    const data = await getConversationService().listSessions(user.id);
    return NextResponse.json(
      {
        message: 'Get sessions success!',
        data: data || [],
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('Get sessions error:', error);
    return toHttpError(error, 'Get sessions failed!');
  }
}
