/**
 * POST /api/auth/register —— 薄适配器：逻辑见 @/backend/controllers/auth-controller。
 */

import { withApiHandler } from '@/backend/http';
import * as authController from '@/backend/controllers/auth-controller';
import { authRateLimits } from '@/backend/controllers/auth-controller';
import { credentialsSchema } from '@/backend/validation/schemas';

export { OPTIONS } from '@/backend/http/preflight';

export const POST = withApiHandler(
  { auth: 'none', body: credentialsSchema, rateLimit: authRateLimits.register },
  authController.register,
);
