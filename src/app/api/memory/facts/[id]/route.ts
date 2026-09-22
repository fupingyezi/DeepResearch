import { NextResponse } from 'next/server';

import { withApiHandler } from '@/server/http';
import { getMemoryService } from '@/server/services/memory-service';
import { updateMemoryFactSchema } from '@/server/validation/schemas';

/** 更新指定记忆 fact 的内容/分类/置信度。 */
export const PUT = withApiHandler(
  { body: updateMemoryFactSchema, fallbackMessage: 'Update fact failed' },
  async ({ user, body, params }) => {
    const data = await getMemoryService().updateFact(user!.id, params.id, body);
    return NextResponse.json({ message: 'Update fact success!', data }, { status: 200 });
  },
);

/** 删除指定记忆 fact。 */
export const DELETE = withApiHandler(
  { fallbackMessage: 'Delete fact failed' },
  async ({ user, params }) => {
    const data = await getMemoryService().deleteFact(user!.id, params.id);
    return NextResponse.json({ message: 'Delete fact success!', data }, { status: 200 });
  },
);
