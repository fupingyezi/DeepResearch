import { NextResponse } from 'next/server';

import { withApiHandler } from '@/server/http';
import { getMemoryService } from '@/server/services/memory-service';

/** 读取当前用户的记忆（结构化 summary + facts）。 */
export const GET = withApiHandler({ fallbackMessage: 'Get memory failed' }, async ({ user }) => {
  const data = await getMemoryService().getMemory(user!.id);
  return NextResponse.json({ message: 'Get memory success!', data }, { status: 200 });
});

/** 清空当前用户的全部记忆。 */
export const DELETE = withApiHandler(
  { fallbackMessage: 'Clear memory failed' },
  async ({ user }) => {
    const data = await getMemoryService().clearMemory(user!.id);
    return NextResponse.json({ message: 'Clear memory success!', data }, { status: 200 });
  },
);
