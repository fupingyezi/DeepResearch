import { NextRequest, NextResponse } from 'next/server';

import { query } from '@/lib';
import { getCurrentUser } from '../../auth/_helpers';

export async function GET(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  try {
    const response = await query(
      'select * from chat_session where user_id = $1 order by updated_at desc',
      [user.id],
    );

    return NextResponse.json(
      {
        message: 'Get sessions success!',
        data: response.rows || [],
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('Get sessions error:', error);
    return NextResponse.json(
      {
        message: 'Get sessions failed!',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
