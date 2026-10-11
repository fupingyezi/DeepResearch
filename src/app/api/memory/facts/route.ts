import { withApiHandler } from '@/backend/http';
import { memoryController } from '@/backend/controllers/memory-controller';
import { createMemoryFactSchema } from '@/backend/validation/schemas';

export { OPTIONS } from '@/backend/http/preflight';

export const POST = withApiHandler(
  { body: createMemoryFactSchema, fallbackMessage: 'Create fact failed' },
  memoryController.createFact,
);
