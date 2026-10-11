// 薄适配器：管线选项在此，handler 见 src/backend/controllers/threads-controller.ts
import { withApiHandler } from '@/backend/http';
import * as threadsController from '@/backend/controllers/threads-controller';
import { listQuerySchema, submitRunSchema } from '@/backend/validation/schemas';

export { OPTIONS } from '@/backend/http/preflight';

export const POST = withApiHandler(
  {
    body: submitRunSchema,
    fallbackMessage: 'failed to submit run',
  },
  threadsController.submitRun,
);

export const GET = withApiHandler(
  {
    query: listQuerySchema,
    fallbackMessage: 'failed to list runs',
  },
  threadsController.listRuns,
);
