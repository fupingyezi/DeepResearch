import { mcpController } from '@/backend/controllers/mcp-controller';
import { withApiHandler } from '@/backend/http';
import { patchEnabledSchema } from '@/backend/validation/schemas';

export { OPTIONS } from '@/backend/http/preflight';

export const runtime = 'nodejs';

export const PATCH = withApiHandler(
  { body: patchEnabledSchema, fallbackMessage: 'Update MCP server failed' },
  mcpController.setServerEnabled,
);

export const DELETE = withApiHandler(
  { fallbackMessage: 'Delete MCP server failed' },
  mcpController.removeServer,
);
