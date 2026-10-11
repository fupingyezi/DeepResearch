import { withApiHandler } from '@/backend/http';
import { filesController, parseUploadBody } from '@/backend/controllers/files-controller';

export { OPTIONS } from '@/backend/http/preflight';

export const POST = withApiHandler({ body: parseUploadBody }, filesController.upload);
