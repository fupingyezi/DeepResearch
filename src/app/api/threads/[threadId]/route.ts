// 薄适配器：管线选项在此，handler 见 src/backend/controllers/threads-controller.ts
import { withApiHandler } from '@/backend/http';
import * as threadsController from '@/backend/controllers/threads-controller';
import { getThreadQuerySchema } from '@/backend/validation/schemas';

export { OPTIONS } from '@/backend/http/preflight';

export const GET = withApiHandler(
  {
    query: getThreadQuerySchema,
    fallbackMessage: 'failed to get thread',
  },
  threadsController.get,
);

export const DELETE = withApiHandler(
  { fallbackMessage: 'failed to delete thread' },
  threadsController.deleteThread,
);
