/**
 * MCP 客户端封装。
 *
 * 按 extensions_config.json 中启用的 MCP server 构建 MultiServerMCPClient，
 * 加载其工具供 lead-agent 使用。
 *
 * 关键不变量 / 坑位：
 * - 单服务器失败容错：`throwOnLoadError: false`，单个 server 连不上时跳过，
 *   不抛错阻断对话（满足 project.md §8：stream 首帧前 await 完成且不崩）。
 * - 工具名前缀：`prefixToolNameWithServerName: true`，避免 MCP 工具与内置工具
 *   （search_web_tool / task 等）重名冲突。
 * - 连接缓存：按「启用 server 配置签名」缓存 client 与工具；签名变化时关闭旧
 *   client 再重建，避免每轮 stream 重连 stdio 子进程 / 重开 SSE。
 * - 运行时：stdio server 需 spawn 子进程，仅 Node.js runtime 可用。
 */

import type { StructuredToolInterface } from '@langchain/core/tools';
import { MultiServerMCPClient, type Connection } from '@langchain/mcp-adapters';

import {
  getExtensionsConfigStore,
  resolveEnvPlaceholders,
  type McpServerConfig,
} from '../extensions';

/**
 * 把 server 名清洗为合法工具名前缀。
 *
 * mcp-adapters 开启 prefixToolNameWithServerName 后会用 server key 作为工具名前缀
 * （形如 `<serverKey>__<toolName>`）。而 OpenAI 要求函数名匹配 `^[a-zA-Z0-9_-]+$`，
 * 故 server 名含空格/中文等非法字符时会触发 400。这里把非法字符统一替换为 `_`，
 * 并避免空串（兜底为 `server`）。
 */
function sanitizeServerKey(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : 'server';
}

/** 把单个 MCP server 配置翻译为 mcp-adapters Connection；缺关键字段返回 null。 */
function buildConnection(config: McpServerConfig): Connection | null {
  if (config.type === 'stdio') {
    if (!config.command) return null;
    const env = resolveEnvPlaceholders(config.env);
    return {
      transport: 'stdio',
      command: config.command,
      args: config.args ?? [],
      // 仅在显式提供 env 时传入，避免清空子进程默认环境（如 PATH）
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }

  if (!config.url) return null;
  const headers = resolveEnvPlaceholders(config.headers);
  return {
    transport: config.type,
    url: config.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

/** 已启用 server 的稳定签名（排序后 JSON），用于缓存失效与 agent 缓存键。 */
function enabledServersSignature(servers: Record<string, McpServerConfig>): string {
  const enabled = Object.entries(servers)
    .filter(([, c]) => c.enabled)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify(enabled);
}

interface ToolsCache {
  signature: string;
  tools: StructuredToolInterface[];
  client: MultiServerMCPClient;
}

let _cache: ToolsCache | null = null;

/**
 * 已启用 MCP server 的签名（仅读配置，不连接）。
 * 供 DeerFlowClient.buildConfigKey 使用：启用集/配置变化时触发 agent 重建。
 */
export async function getEnabledMcpSignature(): Promise<string> {
  const config = await getExtensionsConfigStore().load();
  return enabledServersSignature(config.mcpServers);
}

/**
 * 加载启用 MCP server 的工具。命中签名缓存则直接返回；否则关闭旧 client 重建。
 * 任意失败都降级为返回当前可用工具（或空数组），绝不抛错。
 */
export async function loadMcpTools(): Promise<StructuredToolInterface[]> {
  const config = await getExtensionsConfigStore().load();
  const signature = enabledServersSignature(config.mcpServers);

  if (_cache && _cache.signature === signature) {
    return _cache.tools;
  }

  if (_cache) {
    await _cache.client.close().catch(() => undefined);
    _cache = null;
  }

  const mcpServers: Record<string, Connection> = {};
  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    if (!serverConfig.enabled) continue;
    const connection = buildConnection(serverConfig);
    if (!connection) continue;
    // 清洗为合法前缀；若与已有 key 冲突则追加序号，避免工具被覆盖。
    let key = sanitizeServerKey(name);
    if (mcpServers[key]) {
      let i = 2;
      while (mcpServers[`${key}_${i}`]) i += 1;
      key = `${key}_${i}`;
    }
    mcpServers[key] = connection;
  }

  if (Object.keys(mcpServers).length === 0) {
    return [];
  }

  const client = new MultiServerMCPClient({
    mcpServers,
    throwOnLoadError: false,
    prefixToolNameWithServerName: true,
    useStandardContentBlocks: true,
  });

  try {
    const tools = await client.getTools();
    _cache = { signature, tools, client };
    return tools;
  } catch (e) {
    console.warn('[mcp/client] Failed to load MCP tools, continue without them:', e);
    await client.close().catch(() => undefined);
    return [];
  }
}

/** 关闭并清空 MCP 客户端缓存（配置删除/重置时调用）。 */
export async function resetMcpClient(): Promise<void> {
  if (_cache) {
    await _cache.client.close().catch(() => undefined);
    _cache = null;
  }
}
