import * as toolsController from '@/backend/controllers/tools-controller';
import { withApiHandler } from '@/backend/http';

export const GET = withApiHandler({}, toolsController.list);
