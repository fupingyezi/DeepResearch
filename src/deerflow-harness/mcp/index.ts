/**
 * MCP Module — deerflow-harness
 *
 * MCP（Model Context Protocol）协议适配器（预留模块）
 *
 * @module deerflow-harness/mcp
 */

/**
 * MCP 适配器接口
 *
 * 未来实现时，MCP 适配器将支持连接外部 MCP 服务器，
 * 并将其提供的工具转换为 Agent 可用的 LangChain Tool。
 */
export interface MCPAdapter {
  /** 适配器名称 */
  name: string;
  /** 连接到 MCP 服务器 */
  connect(serverUrl: string): Promise<void>;
  /** 断开连接 */
  disconnect(): Promise<void>;
  /** 获取可用工具列表 */
  getTools(): Promise<MCPTool[]>;
}

/** MCP 工具描述 */
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
