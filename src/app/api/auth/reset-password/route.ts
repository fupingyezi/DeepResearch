/**
 * POST /api/auth/reset-password —— 薄适配器：逻辑见 @/backend/controllers/auth-controller。
 */

import { withApiHandler } from '@/backend/http';
import { authController } from '@/backend/controllers/auth-controller';
import { resetPasswordSchema } from '@/backend/validation/schemas';

export { OPTIONS } from '@/backend/http/preflight';

export const POST = withApiHandler(
  { auth: 'none', body: resetPasswordSchema },
  authController.resetPassword,
);
