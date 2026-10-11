// 薄适配器：管线选项在此，handler 见 src/backend/controllers/threads-controller.ts
import { withApiHandler } from '@/backend/http';
import { threadsController } from '@/backend/controllers/threads-controller';
import { runStreamQuerySchema } from '@/backend/validation/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApiHandler(
  {
    query: runStreamQuerySchema,
    fallbackMessage: 'failed to subscribe run stream',
  },
  threadsController.streamRun,
);
