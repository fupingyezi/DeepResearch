/**
 * POST /api/auth/demo-login —— 薄适配器：逻辑见 @/backend/controllers/auth-controller。
 */

import { withApiHandler } from '@/backend/http';
import { authController, authRateLimits } from '@/backend/controllers/auth-controller';

export { OPTIONS } from '@/backend/http/preflight';

export const POST = withApiHandler(
  { auth: 'none', rateLimit: authRateLimits.demoLogin },
  authController.demoLogin,
);
