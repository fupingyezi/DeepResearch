/**
 * POST /api/auth/login —— 薄适配器：逻辑见 @/backend/controllers/auth-controller。
 */

import { withApiHandler } from '@/backend/http';
import { authController, authRateLimits } from '@/backend/controllers/auth-controller';
import { credentialsSchema } from '@/backend/validation/schemas';

export { OPTIONS } from '@/backend/http/preflight';

export const POST = withApiHandler(
  { auth: 'none', body: credentialsSchema, rateLimit: authRateLimits.login },
  authController.login,
);
