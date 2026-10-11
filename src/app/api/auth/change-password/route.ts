/**
 * POST /api/auth/change-password —— 薄适配器：逻辑见 @/backend/controllers/auth-controller。
 */

import { withApiHandler } from '@/backend/http';
import * as authController from '@/backend/controllers/auth-controller';
import { authRateLimits } from '@/backend/controllers/auth-controller';
import { changePasswordSchema } from '@/backend/validation/schemas';

export { OPTIONS } from '@/backend/http/preflight';

export const POST = withApiHandler(
  { body: changePasswordSchema, rateLimit: authRateLimits.changePassword },
  authController.changePassword,
);
