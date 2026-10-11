import { withApiHandler } from '@/backend/http';
import { healthController } from '@/backend/controllers/health-controller';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = withApiHandler({ auth: 'none' }, healthController.get);
