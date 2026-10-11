// 薄适配器：管线选项在此，handler 见 src/backend/controllers/conversations-controller.ts
import { withApiHandler } from '@/backend/http';
import * as conversationsController from '@/backend/controllers/conversations-controller';
import { sessionIdBodySchema, updateSessionBodySchema } from '@/backend/validation/schemas';

export { OPTIONS } from '@/backend/http/preflight';

export const POST = withApiHandler(
  { body: updateSessionBodySchema, fallbackMessage: 'Failed to update session' },
  conversationsController.renameSession,
);

export const DELETE = withApiHandler(
  { body: sessionIdBodySchema, fallbackMessage: 'Failed to delete session' },
  conversationsController.deleteSession,
);
