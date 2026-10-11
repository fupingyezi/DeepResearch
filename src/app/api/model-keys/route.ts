import * as modelKeysController from '@/backend/controllers/model-keys-controller';
import { withApiHandler } from '@/backend/http';
import { patchSelectedModelSchema, putModelKeySchema } from '@/backend/validation/schemas';

export { OPTIONS } from '@/backend/http/preflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApiHandler(
  { fallbackMessage: 'Get model keys failed' },
  modelKeysController.list,
);

export const PUT = withApiHandler(
  { body: putModelKeySchema, fallbackMessage: 'Save model key failed' },
  modelKeysController.saveKey,
);

export const PATCH = withApiHandler(
  { body: patchSelectedModelSchema, fallbackMessage: 'Set selected model failed' },
  modelKeysController.selectModel,
);
