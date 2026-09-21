import { NextRequest, NextResponse } from 'next/server';

import { getCurrentUser, toHttpError } from '@/server/http';
import { getMemoryService } from '@/server/services/memory-service';
import { parseJsonBody } from '@/server/validation';
import { createMemoryFactSchema } from '@/server/validation/schemas';

/** 新增一条记忆 fact（来源标记为 manual）。 */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const parsed = await parseJsonBody(request, createMemoryFactSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const data = await getMemoryService().createFact(user.id, parsed.data);
    return NextResponse.json({ message: 'Create fact success!', data }, { status: 200 });
  } catch (error) {
    console.error('[memory] create fact error:', error);
    return toHttpError(error, 'Create fact failed');
  }
}
