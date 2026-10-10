import { withApiHandler } from '@/backend/http';
import { isAuthorized, sandboxController } from '@/backend/controllers/sandbox-controller';
import { sandboxStatsQuerySchema } from '@/backend/validation/schemas';

export const runtime = 'nodejs';

export const GET = withApiHandler(
  {
    auth: 'none',
    guard: isAuthorized,
    query: sandboxStatsQuerySchema,
    fallbackMessage: 'failed to read sandbox stats',
  },
  sandboxController.stats,
);
