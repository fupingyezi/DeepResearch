import { NextRequest, NextResponse } from 'next/server';

import { clearMemoryData, getMemoryData } from '@/deerflow-harness';
import { getCurrentUser } from '../auth/_helpers';

/** 读取当前用户的记忆（结构化 summary + facts）。 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  try {
    const data = await getMemoryData(null, user.id);
    return NextResponse.json({ message: 'Get memory success!', data }, { status: 200 });
  } catch (error) {
    console.error('[memory] get error:', error);
    return NextResponse.json(
      { message: 'Get memory failed!', error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

/** 清空当前用户的全部记忆。 */
export async function DELETE(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  try {
    const data = await clearMemoryData(null, user.id);
    return NextResponse.json({ message: 'Clear memory success!', data }, { status: 200 });
  } catch (error) {
    console.error('[memory] clear error:', error);
    return NextResponse.json(
      { message: 'Clear memory failed!', error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
