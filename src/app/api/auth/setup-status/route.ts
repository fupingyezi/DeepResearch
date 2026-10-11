/**
 * GET /api/auth/setup-status —— 薄适配器：逻辑见 @/backend/controllers/auth-controller。
 */

import { withApiHandler } from '@/backend/http';
import { authController } from '@/backend/controllers/auth-controller';

// 每次实时查询 admin 是否存在，禁止静态预渲染缓存
export const dynamic = 'force-dynamic';

export const GET = withApiHandler({ auth: 'none' }, authController.getSetupStatus);
