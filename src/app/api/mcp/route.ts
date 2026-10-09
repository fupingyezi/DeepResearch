import { NextResponse } from 'next/server';

import { withApiHandler } from '@/server/http';
import { getExtensionService } from '@/server/services/extension-service';
import { upsertMcpServerSchema } from '@/server/validation/schemas';

export { OPTIONS } from '@/server/http/preflight';

export const runtime = 'nodejs';

/** 读取 MCP 服务器配置（不解析 env 占位，原样返回供编辑）。 */
export const GET = withApiHandler({ fallbackMessage: 'Get MCP config failed' }, async () => {
  const mcpServers = await getExtensionService().listMcpServers();
  return NextResponse.json(
    { message: 'Get MCP config success!', data: { mcpServers } },
    { status: 200 },
  );
});

/** 新增或更新一个 MCP 服务器配置。 */
export const POST = withApiHandler(
  { body: upsertMcpServerSchema, fallbackMessage: 'Save MCP server failed' },
  async ({ body }) => {
    const server = await getExtensionService().upsertMcpServer(body.name, body.config);
    return NextResponse.json(
      { message: 'Save MCP server success!', data: server },
      { status: 200 },
    );
  },
);
