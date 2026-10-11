// 薄适配器：管线选项在此，handler 见 src/backend/controllers/conversations-controller.ts
import { withApiHandler } from '@/backend/http';
import * as conversationsController from '@/backend/controllers/conversations-controller';

export const GET = withApiHandler(
  { fallbackMessage: 'Get sessions failed!' },
  conversationsController.listSessions,
);
