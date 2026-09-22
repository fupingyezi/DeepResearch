import { NextRequest, NextResponse } from 'next/server';

import { getCurrentUser, toHttpError } from '@/server/http';
import { getExtensionService } from '@/server/services/extension-service';
import { parseJsonBody } from '@/server/validation';
import { createSkillSchema } from '@/server/validation/schemas';

// stdio MCP / 文件系统访问需 Node.js runtime
export const runtime = 'nodejs';

/** 列出全部 skill（public + custom，含 enabled 状态）。 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  try {
    const skills = await getExtensionService().listSkills();
    return NextResponse.json({ message: 'Get skills success!', data: skills }, { status: 200 });
  } catch (error) {
    console.error('[skills] list error:', error);
    return toHttpError(error, 'Get skills failed');
  }
}

/** 新建自定义 skill（写入 skills/custom/<name>/SKILL.md）。 */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const parsed = await parseJsonBody(request, createSkillSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const skill = await getExtensionService().createSkill(parsed.data.name, parsed.data.content);
    return NextResponse.json({ message: 'Create skill success!', data: skill }, { status: 201 });
  } catch (error) {
    return toHttpError(error, 'Create skill failed');
  }
}
