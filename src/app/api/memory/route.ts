import { NextRequest, NextResponse } from 'next/server';

import { getCurrentUser, toHttpError } from '@/server/http';
import { getMemoryService } from '@/server/services/memory-service';

/** 读取当前用户的记忆（结构化 summary + facts）。 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  try {
    const data = await getMemoryService().getMemory(user.id);
    return NextResponse.json({ message: 'Get memory success!', data }, { status: 200 });
  } catch (error) {
    console.error('[memory] get error:', error);
    return toHttpError(error, 'Get memory failed');
  }
}

/** 清空当前用户的全部记忆。 */
export async function DELETE(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  try {
    const data = await getMemoryService().clearMemory(user.id);
    return NextResponse.json({ message: 'Clear memory success!', data }, { status: 200 });
  } catch (error) {
    console.error('[memory] clear error:', error);
    return toHttpError(error, 'Clear memory failed');
  }
}
