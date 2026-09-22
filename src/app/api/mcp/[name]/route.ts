import { NextRequest, NextResponse } from 'next/server';

import { getCurrentUser, toHttpError } from '@/server/http';
import { getExtensionService } from '@/server/services/extension-service';
import { parseJsonBody } from '@/server/validation';
import { patchEnabledSchema } from '@/server/validation/schemas';

export const runtime = 'nodejs';

/** 切换某个 MCP 服务器的启用状态。 */
export async function PATCH(request: NextRequest, { params }: { params: { name: string } }) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const parsed = await parseJsonBody(request, patchEnabledSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const server = await getExtensionService().setMcpServerEnabled(
      params.name,
      parsed.data.enabled,
    );
    return NextResponse.json(
      { message: 'Update MCP server success!', data: server },
      { status: 200 },
    );
  } catch (error) {
    return toHttpError(error, 'Update MCP server failed');
  }
}

/** 删除某个 MCP 服务器配置。 */
export async function DELETE(request: NextRequest, { params }: { params: { name: string } }) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  try {
    await getExtensionService().removeMcpServer(params.name);
    return NextResponse.json({ message: 'Delete MCP server success!' }, { status: 200 });
  } catch (error) {
    console.error('[mcp] delete error:', error);
    return toHttpError(error, 'Delete MCP server failed');
  }
}
