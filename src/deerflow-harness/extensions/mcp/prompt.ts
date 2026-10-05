/**
 * 已加载 MCP 工具的系统提示注入。
 */

import type { StructuredToolInterface } from '@langchain/core/tools';

/**
 * 构建 <mcp_tools> 注入块；无已加载 MCP 工具时返回空字符串。
 * 工具名已带服务器前缀（见 client.ts prefixToolNameWithServerName）。
 */
export function buildMcpToolsSection(tools: StructuredToolInterface[]): string {
  if (tools.length === 0) return '';

  const lines = tools
    .map((tool) => {
      const name = (tool as { name?: string }).name ?? '';
      const description = (tool as { description?: string }).description ?? '';
      return `- \`${name}\`：${description.trim() || '（无描述）'}`;
    })
    .join('\n');

  return `<mcp_tools>
你已通过 MCP（Model Context Protocol）接入以下外部工具，可像内置工具一样直接调用它们完成任务。当用户的需求适合用某个 MCP 工具解决时，直接调用对应工具，不要回答"未接入/未配置 MCP"。

${lines}
</mcp_tools>`;
}
