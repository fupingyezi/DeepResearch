import { NextRequest, NextResponse } from 'next/server';

import { createCustomSkill, loadSkills } from '@/deerflow-harness';
import { getCurrentUser } from '../auth/_helpers';

// stdio MCP / 文件系统访问需 Node.js runtime
export const runtime = 'nodejs';

interface CreateSkillBody {
  name?: string;
  content?: string;
}

/** 列出全部 skill（public + custom，含 enabled 状态）。 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  try {
    const skills = await loadSkills();
    return NextResponse.json({ message: 'Get skills success!', data: skills }, { status: 200 });
  } catch (error) {
    console.error('[skills] list error:', error);
    return NextResponse.json(
      {
        message: 'Get skills failed!',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

/** 新建自定义 skill（写入 skills/custom/<name>/SKILL.md）。 */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  let body: CreateSkillBody;
  try {
    body = (await request.json()) as CreateSkillBody;
  } catch {
    return NextResponse.json({ message: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.name || typeof body.name !== 'string') {
    return NextResponse.json({ message: 'Field "name" is required' }, { status: 400 });
  }
  if (!body.content || typeof body.content !== 'string') {
    return NextResponse.json({ message: 'Field "content" is required' }, { status: 400 });
  }

  try {
    const skill = await createCustomSkill({ name: body.name, content: body.content });
    return NextResponse.json({ message: 'Create skill success!', data: skill }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        message: 'Create skill failed!',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 400 },
    );
  }
}
