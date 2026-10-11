// 薄适配器：管线选项在此，handler 见 src/backend/controllers/threads-controller.ts
import { withApiHandler } from '@/backend/http';
import { threadsController } from '@/backend/controllers/threads-controller';
import { createThreadSchema, listQuerySchema } from '@/backend/validation/schemas';

export { OPTIONS } from '@/backend/http/preflight';

export const POST = withApiHandler(
  {
    body: createThreadSchema,
    fallbackMessage: 'failed to create thread',
  },
  threadsController.create,
);

export const GET = withApiHandler(
  {
    query: listQuerySchema,
    fallbackMessage: 'failed to list threads',
  },
  threadsController.list,
);
