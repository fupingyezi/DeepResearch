import { modelKeysController } from '@/backend/controllers/model-keys-controller';
import { withApiHandler } from '@/backend/http';

export { OPTIONS } from '@/backend/http/preflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const DELETE = withApiHandler(
  { fallbackMessage: 'Delete model key failed' },
  modelKeysController.deleteKey,
);
