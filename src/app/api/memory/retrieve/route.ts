import { withApiHandler } from '@/backend/http';
import { memoryController } from '@/backend/controllers/memory-controller';
import { retrievePreviewSchema } from '@/backend/validation/schemas.preview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApiHandler(
  { query: retrievePreviewSchema, fallbackMessage: 'Retrieve preview failed' },
  memoryController.retrievePreview,
);
