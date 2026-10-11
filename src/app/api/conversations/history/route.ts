// 薄适配器：管线选项在此，handler 见 src/backend/controllers/conversations-controller.ts
import { withApiHandler } from '@/backend/http';
import * as conversationsController from '@/backend/controllers/conversations-controller';
import { historyQuerySchema } from '@/backend/validation/schemas';

export const GET = withApiHandler(
  { query: historyQuerySchema, fallbackMessage: 'Get history failed!' },
  conversationsController.history,
);
