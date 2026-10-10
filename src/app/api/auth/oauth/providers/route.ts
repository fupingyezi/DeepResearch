/**
 * GET /api/auth/oauth/providers —— 薄适配器：逻辑见 @/backend/controllers/oauth-controller。
 */

import { withApiHandler } from '@/backend/http';
import { oauthController } from '@/backend/controllers/oauth-controller';

export { OPTIONS } from '@/backend/http/preflight';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler({ auth: 'none' }, oauthController.listProviders);
