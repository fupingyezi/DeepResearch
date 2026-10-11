/**
 * POST /api/auth/logout —— 薄适配器：逻辑见 @/backend/controllers/auth-controller。
 */

import { withApiHandler } from '@/backend/http';
import { authController } from '@/backend/controllers/auth-controller';

export { OPTIONS } from '@/backend/http/preflight';

export const POST = withApiHandler({ auth: 'none' }, authController.logout);
