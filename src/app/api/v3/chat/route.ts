// 薄适配器：管线选项在此，handler 见 src/backend/controllers/chat-controller.ts
import { withApiHandler } from '@/backend/http';
import * as chatController from '@/backend/controllers/chat-controller';
import { chatStreamBodySchema } from '@/backend/validation/schemas';

export { OPTIONS } from '@/backend/http/preflight';

export const POST = withApiHandler({ body: chatStreamBodySchema }, chatController.post);
