/**
 * POST /api/auth/resend-verification —— 薄适配器：逻辑见 @/backend/controllers/auth-controller。
 */

import { withApiHandler } from '@/backend/http';
import * as authController from '@/backend/controllers/auth-controller';
import { authRateLimits } from '@/backend/controllers/auth-controller';

export { OPTIONS } from '@/backend/http/preflight';

export const POST = withApiHandler(
  { rateLimit: authRateLimits.resendVerification },
  authController.resendVerification,
);
