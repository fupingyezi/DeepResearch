/**
 * MCP 工具加载相关类型。
 *
 * 复用 extensions 子系统的 McpServerConfig 作为配置来源；本模块负责把它翻译为
 * @langchain/mcp-adapters 的 Connection 形态并加载工具。
 */

import type { StructuredToolInterface } from '@langchain/core/tools';

export interface McpToolsResult {
  tools: StructuredToolInterface[];
  /** 实际成功加载工具的已启用服务器名。 */
  loadedServers: string[];
}
