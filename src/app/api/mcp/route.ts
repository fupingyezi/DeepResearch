import { mcpController } from '@/backend/controllers/mcp-controller';
import { withApiHandler } from '@/backend/http';
import { upsertMcpServerSchema } from '@/backend/validation/schemas';

export { OPTIONS } from '@/backend/http/preflight';

export const runtime = 'nodejs';

export const GET = withApiHandler({ fallbackMessage: 'Get MCP config failed' }, mcpController.list);

export const POST = withApiHandler(
  { body: upsertMcpServerSchema, fallbackMessage: 'Save MCP server failed' },
  mcpController.upsert,
);
