import { withApiHandler } from '@/backend/http';
import * as filesController from '@/backend/controllers/files-controller';
import { parseUploadBody } from '@/backend/controllers/files-controller';

export { OPTIONS } from '@/backend/http/preflight';

export const POST = withApiHandler({ body: parseUploadBody }, filesController.upload);
