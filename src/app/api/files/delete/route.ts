import { withApiHandler } from '@/backend/http';
import * as filesController from '@/backend/controllers/files-controller';
import { fileIdBodySchema } from '@/backend/validation/schemas';

export { OPTIONS } from '@/backend/http/preflight';

export const DELETE = withApiHandler({ body: fileIdBodySchema }, filesController.deleteFile);
