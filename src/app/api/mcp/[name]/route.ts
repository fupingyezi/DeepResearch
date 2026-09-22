import { NextResponse } from 'next/server';

import { withApiHandler } from '@/server/http';
import { getExtensionService } from '@/server/services/extension-service';
import { patchEnabledSchema } from '@/server/validation/schemas';

export const runtime = 'nodejs';

/** 切换某个 MCP 服务器的启用状态。 */
export const PATCH = withApiHandler(
  { body: patchEnabledSchema, fallbackMessage: 'Update MCP server failed' },
  async ({ body, params }) => {
    const server = await getExtensionService().setMcpServerEnabled(params.name, body.enabled);
    return NextResponse.json(
      { message: 'Update MCP server success!', data: server },
      { status: 200 },
    );
  },
);

/** 删除某个 MCP 服务器配置。 */
export const DELETE = withApiHandler(
  { fallbackMessage: 'Delete MCP server failed' },
  async ({ params }) => {
    await getExtensionService().removeMcpServer(params.name);
    return NextResponse.json({ message: 'Delete MCP server success!' }, { status: 200 });
  },
);
