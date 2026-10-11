import { withApiHandler } from '@/backend/http';
import * as memoryController from '@/backend/controllers/memory-controller';
import { updateMemoryFactSchema } from '@/backend/validation/schemas';

export { OPTIONS } from '@/backend/http/preflight';

export const PUT = withApiHandler(
  { body: updateMemoryFactSchema, fallbackMessage: 'Update fact failed' },
  memoryController.updateFact,
);
export const DELETE = withApiHandler(
  { fallbackMessage: 'Delete fact failed' },
  memoryController.deleteFact,
);
