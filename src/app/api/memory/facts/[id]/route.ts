import { NextRequest, NextResponse } from 'next/server';

import { getCurrentUser, toHttpError } from '@/server/http';
import { getMemoryService } from '@/server/services/memory-service';
import { parseJsonBody } from '@/server/validation';
import { updateMemoryFactSchema } from '@/server/validation/schemas';

/** 更新指定记忆 fact 的内容/分类/置信度。 */
export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const parsed = await parseJsonBody(request, updateMemoryFactSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const data = await getMemoryService().updateFact(user.id, params.id, parsed.data);
    return NextResponse.json({ message: 'Update fact success!', data }, { status: 200 });
  } catch (error) {
    console.error('[memory] update fact error:', error);
    return toHttpError(error, 'Update fact failed');
  }
}

/** 删除指定记忆 fact。 */
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  try {
    const data = await getMemoryService().deleteFact(user.id, params.id);
    return NextResponse.json({ message: 'Delete fact success!', data }, { status: 200 });
  } catch (error) {
    console.error('[memory] delete fact error:', error);
    return toHttpError(error, 'Delete fact failed');
  }
}
