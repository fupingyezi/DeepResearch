/**
 * POST /api/auth/forgot-password —— 薄适配器：逻辑见 @/backend/controllers/auth-controller。
 */

import { withApiHandler } from '@/backend/http';
import { authController, authRateLimits } from '@/backend/controllers/auth-controller';
import { forgotPasswordSchema } from '@/backend/validation/schemas';

export { OPTIONS } from '@/backend/http/preflight';

export const POST = withApiHandler(
  { auth: 'none', body: forgotPasswordSchema, rateLimit: authRateLimits.forgotPassword },
  authController.forgotPassword,
);
