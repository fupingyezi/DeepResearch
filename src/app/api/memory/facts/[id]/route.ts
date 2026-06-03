import { NextRequest, NextResponse } from 'next/server';

import { deleteMemoryFact, updateMemoryFact, type FactCategory } from '@/deerflow-harness';
import { getCurrentUser } from '../../../auth/_helpers';

const VALID_CATEGORIES = new Set<FactCategory>([
  'preference',
  'knowledge',
  'context',
  'behavior',
  'goal',
  'correction',
]);

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.includes('not found');
}

/** 更新指定记忆 fact 的内容/分类/置信度。 */
export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const patch: { content?: string; category?: FactCategory; confidence?: number } = {};

  if (typeof body?.content === 'string') {
    const content = body.content.trim();
    if (!content) {
      return NextResponse.json({ message: 'content 不能为空' }, { status: 400 });
    }
    patch.content = content;
  }
  if (typeof body?.category === 'string' && VALID_CATEGORIES.has(body.category as FactCategory)) {
    patch.category = body.category as FactCategory;
  }
  if (typeof body?.confidence === 'number' && body.confidence >= 0 && body.confidence <= 1) {
    patch.confidence = body.confidence;
  }

  try {
    const data = await updateMemoryFact(params.id, patch, null, user.id);
    return NextResponse.json({ message: 'Update fact success!', data }, { status: 200 });
  } catch (error) {
    if (isNotFound(error)) {
      return NextResponse.json({ message: '记忆条目不存在' }, { status: 404 });
    }
    console.error('[memory] update fact error:', error);
    return NextResponse.json(
      { message: 'Update fact failed!', error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

/** 删除指定记忆 fact。 */
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  try {
    const data = await deleteMemoryFact(params.id, null, user.id);
    return NextResponse.json({ message: 'Delete fact success!', data }, { status: 200 });
  } catch (error) {
    if (isNotFound(error)) {
      return NextResponse.json({ message: '记忆条目不存在' }, { status: 404 });
    }
    console.error('[memory] delete fact error:', error);
    return NextResponse.json(
      { message: 'Delete fact failed!', error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
