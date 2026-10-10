/**
 * mcp 域 HTTP 层逻辑（自 route.ts 抽出）：MCP 服务器配置的读取 / 新增 / 启停 / 删除。
 *
 * route.ts（/api/mcp 与 /api/mcp/[name]）是薄适配器，只保留 withApiHandler
 * 选项与 Next 配置导出（runtime），不再含业务 handler 体。
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { ApiRouteHandler } from '@/backend/http';
import { getExtensionService } from '@/backend/services/extension-service';
import { patchEnabledSchema, upsertMcpServerSchema } from '@/backend/validation/schemas';

/** 读取 MCP 服务器配置（不解析 env 占位，原样返回供编辑）。 */
export const list: ApiRouteHandler<undefined, undefined> = async () => {
  const mcpServers = await getExtensionService().listMcpServers();
  return NextResponse.json(
    { message: 'Get MCP config success!', data: { mcpServers } },
    { status: 200 },
  );
};

/** 新增或更新一个 MCP 服务器配置。 */
export const upsert: ApiRouteHandler<z.infer<typeof upsertMcpServerSchema>, undefined> = async ({
  body,
}) => {
  const server = await getExtensionService().upsertMcpServer(body.name, body.config);
  return NextResponse.json({ message: 'Save MCP server success!', data: server }, { status: 200 });
};

/** 切换某个 MCP 服务器的启用状态。 */
export const setServerEnabled: ApiRouteHandler<
  z.infer<typeof patchEnabledSchema>,
  undefined
> = async ({ body, params }) => {
  const server = await getExtensionService().setMcpServerEnabled(params.name, body.enabled);
  return NextResponse.json(
    { message: 'Update MCP server success!', data: server },
    { status: 200 },
  );
};

/** 删除某个 MCP 服务器配置。 */
export const removeServer: ApiRouteHandler<undefined, undefined> = async ({ params }) => {
  await getExtensionService().removeMcpServer(params.name);
  return NextResponse.json({ message: 'Delete MCP server success!' }, { status: 200 });
};

export const mcpController = { list, upsert, setServerEnabled, removeServer };
