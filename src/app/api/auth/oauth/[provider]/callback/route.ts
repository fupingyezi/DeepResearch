/**
 * GET /api/auth/oauth/[provider]/callback —— 薄适配器：逻辑见 @/backend/controllers/oauth-controller。
 */

import { withApiHandler } from '@/backend/http';
import { oauthController, oauthRateLimits } from '@/backend/controllers/oauth-controller';
import { oauthCallbackQuerySchema } from '@/backend/validation/schemas';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(
  { auth: 'none', query: oauthCallbackQuerySchema, rateLimit: oauthRateLimits.callback },
  oauthController.callback,
);
