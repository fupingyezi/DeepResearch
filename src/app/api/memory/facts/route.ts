import { NextRequest, NextResponse } from 'next/server';

import { createMemoryFact, type FactCategory } from '@/deerflow-harness';
import { getCurrentUser } from '../../auth/_helpers';

const VALID_CATEGORIES = new Set<FactCategory>([
  'preference',
  'knowledge',
  'context',
  'behavior',
  'goal',
  'correction',
]);

/** 新增一条记忆 fact（来源标记为 manual）。 */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const content = typeof body?.content === 'string' ? body.content.trim() : '';
  if (!content) {
    return NextResponse.json({ message: 'content 不能为空' }, { status: 400 });
  }

  const rawCategory = typeof body?.category === 'string' ? body.category : 'context';
  const category = (VALID_CATEGORIES.has(rawCategory as FactCategory)
    ? rawCategory
    : 'context') as FactCategory;

  const confidence =
    typeof body?.confidence === 'number' && body.confidence >= 0 && body.confidence <= 1
      ? body.confidence
      : 0.6;

  try {
    const data = await createMemoryFact(content, category, confidence, null, user.id);
    return NextResponse.json({ message: 'Create fact success!', data }, { status: 200 });
  } catch (error) {
    console.error('[memory] create fact error:', error);
    return NextResponse.json(
      { message: 'Create fact failed!', error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
