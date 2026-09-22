import { NextResponse } from 'next/server';

import { withApiHandler } from '@/server/http';
import { getMemoryService } from '@/server/services/memory-service';
import { createMemoryFactSchema } from '@/server/validation/schemas';

/** 新增一条记忆 fact（来源标记为 manual）。 */
export const POST = withApiHandler(
  { body: createMemoryFactSchema, fallbackMessage: 'Create fact failed' },
  async ({ user, body }) => {
    const data = await getMemoryService().createFact(user!.id, body);
    return NextResponse.json({ message: 'Create fact success!', data }, { status: 200 });
  },
);
