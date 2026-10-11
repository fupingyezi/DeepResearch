/**
 * POST /api/auth/verify-email —— 薄适配器：逻辑见 @/backend/controllers/auth-controller。
 */

import { withApiHandler } from '@/backend/http';
import * as authController from '@/backend/controllers/auth-controller';
import { emailTokenSchema } from '@/backend/validation/schemas';

export { OPTIONS } from '@/backend/http/preflight';

export const POST = withApiHandler(
  { auth: 'none', body: emailTokenSchema },
  authController.verifyEmail,
);
