import * as skillsController from '@/backend/controllers/skills-controller';
import { withApiHandler } from '@/backend/http';
import { patchEnabledSchema } from '@/backend/validation/schemas';

export { OPTIONS } from '@/backend/http/preflight';

export const runtime = 'nodejs';

export const PATCH = withApiHandler(
  { body: patchEnabledSchema, fallbackMessage: 'Update skill failed' },
  skillsController.setEnabled,
);
