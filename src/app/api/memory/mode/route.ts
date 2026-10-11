import { withApiHandler } from '@/backend/http';
import * as memoryController from '@/backend/controllers/memory-controller';
import { setMemoryModeSchema } from '@/backend/validation/schemas';

export { OPTIONS } from '@/backend/http/preflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApiHandler(
  { fallbackMessage: 'Get memory mode failed' },
  memoryController.getMode,
);
export const PUT = withApiHandler(
  { body: setMemoryModeSchema, fallbackMessage: 'Set memory mode failed' },
  memoryController.setMode,
);
