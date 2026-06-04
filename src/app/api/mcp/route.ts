import { NextRequest, NextResponse } from 'next/server';

import { getExtensionsConfigStore, mcpServerConfigSchema } from '@/deerflow-harness';
import { resetMcpClient } from '@/deerflow-harness';
import { getCurrentUser } from '../auth/_helpers';

export const runtime = 'nodejs';

interface UpsertMcpBody {
  name?: string;
  config?: unknown;
}

/** 读取 MCP 服务器配置（不解析 env 占位，原样返回供编辑）。 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  try {
    const config = await getExtensionsConfigStore().load();
    return NextResponse.json(
      { message: 'Get MCP config success!', data: { mcpServers: config.mcpServers } },
      { status: 200 },
    );
  } catch (error) {
    console.error('[mcp] get error:', error);
    return NextResponse.json(
      {
        message: 'Get MCP config failed!',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

/** 新增或更新一个 MCP 服务器配置。 */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  let body: UpsertMcpBody;
  try {
    body = (await request.json()) as UpsertMcpBody;
  } catch {
    return NextResponse.json({ message: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.name || typeof body.name !== 'string') {
    return NextResponse.json({ message: 'Field "name" is required' }, { status: 400 });
  }

  const parsed = mcpServerConfigSchema.safeParse(body.config);
  if (!parsed.success) {
    return NextResponse.json(
      { message: 'Invalid MCP server config', error: parsed.error.message },
      { status: 400 },
    );
  }

  try {
    const config = await getExtensionsConfigStore().setMcpServer(body.name, parsed.data);
    // 配置变更后让 MCP 客户端缓存失效，下轮对话按新配置重连
    await resetMcpClient();
    return NextResponse.json(
      { message: 'Save MCP server success!', data: config.mcpServers[body.name] },
      { status: 200 },
    );
  } catch (error) {
    console.error('[mcp] save error:', error);
    return NextResponse.json(
      {
        message: 'Save MCP server failed!',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
