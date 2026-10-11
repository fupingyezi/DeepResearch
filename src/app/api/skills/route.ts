import { skillsController } from '@/backend/controllers/skills-controller';
import { withApiHandler } from '@/backend/http';
import { createSkillSchema } from '@/backend/validation/schemas';

export { OPTIONS } from '@/backend/http/preflight';

// stdio MCP / 文件系统访问需 Node.js runtime
export const runtime = 'nodejs';

export const GET = withApiHandler({ fallbackMessage: 'Get skills failed' }, skillsController.list);

export const POST = withApiHandler(
  { body: createSkillSchema, fallbackMessage: 'Create skill failed' },
  skillsController.create,
);
