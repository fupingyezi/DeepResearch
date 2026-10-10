import { NextResponse } from 'next/server';

import { withApiHandler } from '@/server/http';
import { getExtensionService } from '@/server/services/extension-service';
import { createSkillSchema } from '@/server/validation/schemas';

export { OPTIONS } from '@/server/http/preflight';

// stdio MCP / 文件系统访问需 Node.js runtime
export const runtime = 'nodejs';

/** 列出全部 skill（public + custom，含 enabled 状态）。 */
export const GET = withApiHandler({ fallbackMessage: 'Get skills failed' }, async () => {
  const skills = await getExtensionService().listSkills();
  return NextResponse.json({ message: 'Get skills success!', data: skills }, { status: 200 });
});

/** 新建自定义 skill（写入 skills/custom/<name>/SKILL.md）。 */
export const POST = withApiHandler(
  { body: createSkillSchema, fallbackMessage: 'Create skill failed' },
  async ({ body }) => {
    const skill = await getExtensionService().createSkill(body.name, body.content);
    return NextResponse.json({ message: 'Create skill success!', data: skill }, { status: 201 });
  },
);
