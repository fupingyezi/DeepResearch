import { NextRequest, NextResponse } from 'next/server';

import { getCurrentUser, toHttpError } from '@/server/http';
import { getExtensionService } from '@/server/services/extension-service';
import { parseJsonBody } from '@/server/validation';
import { upsertMcpServerSchema } from '@/server/validation/schemas';

export const runtime = 'nodejs';

/** 读取 MCP 服务器配置（不解析 env 占位，原样返回供编辑）。 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  try {
    const mcpServers = await getExtensionService().listMcpServers();
    return NextResponse.json(
      { message: 'Get MCP config success!', data: { mcpServers } },
      { status: 200 },
    );
  } catch (error) {
    console.error('[mcp] get error:', error);
    return toHttpError(error, 'Get MCP config failed');
  }
}

/** 新增或更新一个 MCP 服务器配置。 */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const parsed = await parseJsonBody(request, upsertMcpServerSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const server = await getExtensionService().upsertMcpServer(
      parsed.data.name,
      parsed.data.config,
    );
    return NextResponse.json(
      { message: 'Save MCP server success!', data: server },
      { status: 200 },
    );
  } catch (error) {
    console.error('[mcp] save error:', error);
    return toHttpError(error, 'Save MCP server failed');
  }
}
