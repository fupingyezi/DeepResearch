import { withApiHandler } from '@/backend/http';
import { promptController } from '@/backend/controllers/prompt-controller';
import { enhancePromptSchema } from '@/backend/validation/schemas';

export { OPTIONS } from '@/backend/http/preflight';

export const POST = withApiHandler(
  { body: enhancePromptSchema, fallbackMessage: '增强失败' },
  promptController.enhance,
);
