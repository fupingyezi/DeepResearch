import { NextRequest, NextResponse } from 'next/server';

import { getExtensionsConfigStore, resetMcpClient } from '@/deerflow-harness';
import { getCurrentUser } from '../../auth/_helpers';

export const runtime = 'nodejs';

interface PatchMcpBody {
  enabled?: boolean;
}

/** 切换某个 MCP 服务器的启用状态。 */
export async function PATCH(request: NextRequest, { params }: { params: { name: string } }) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  let body: PatchMcpBody;
  try {
    body = (await request.json()) as PatchMcpBody;
  } catch {
    return NextResponse.json({ message: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json({ message: 'Field "enabled" (boolean) is required' }, { status: 400 });
  }

  try {
    const config = await getExtensionsConfigStore().setMcpServerEnabled(params.name, body.enabled);
    await resetMcpClient();
    return NextResponse.json(
      { message: 'Update MCP server success!', data: config.mcpServers[params.name] },
      { status: 200 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = message.includes('not found') ? 404 : 500;
    return NextResponse.json({ message: 'Update MCP server failed!', error: message }, { status });
  }
}

/** 删除某个 MCP 服务器配置。 */
export async function DELETE(request: NextRequest, { params }: { params: { name: string } }) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  try {
    await getExtensionsConfigStore().removeMcpServer(params.name);
    await resetMcpClient();
    return NextResponse.json({ message: 'Delete MCP server success!' }, { status: 200 });
  } catch (error) {
    console.error('[mcp] delete error:', error);
    return NextResponse.json(
      {
        message: 'Delete MCP server failed!',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
