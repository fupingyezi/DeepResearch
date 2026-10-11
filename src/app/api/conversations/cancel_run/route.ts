// 薄适配器：管线选项在此，handler 见 src/backend/controllers/conversations-controller.ts
import { withApiHandler } from '@/backend/http';
import { conversationsController } from '@/backend/controllers/conversations-controller';
import { sessionIdBodySchema } from '@/backend/validation/schemas';

export { OPTIONS } from '@/backend/http/preflight';

export const POST = withApiHandler(
  { body: sessionIdBodySchema, fallbackMessage: 'failed to cancel run' },
  conversationsController.cancelRun,
);
