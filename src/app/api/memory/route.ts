import { withApiHandler } from '@/backend/http';
import { memoryController } from '@/backend/controllers/memory-controller';

export { OPTIONS } from '@/backend/http/preflight';

export const GET = withApiHandler({ fallbackMessage: 'Get memory failed' }, memoryController.get);
export const DELETE = withApiHandler(
  { fallbackMessage: 'Clear memory failed' },
  memoryController.clear,
);
