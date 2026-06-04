/**
 * extensions 子系统类型与 schema。
 *
 * 统一描述 `extensions_config.json` 的形态：
 * - mcpServers：MCP 服务器配置（stdio 用 command/args/env；sse/http 用 url/headers）。
 * - skills：技能启用状态（key = skill name）。
 *
 * 协议字段名与 deer-flow `extensions_config.json` 对齐（mcpServers / skills）。
 */

import { z } from 'zod';

export type McpTransport = 'stdio' | 'sse' | 'http';

export const mcpServerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  type: z.enum(['stdio', 'sse', 'http']).default('stdio'),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  description: z.string().default(''),
});

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export const skillStateSchema = z.object({
  enabled: z.boolean().default(true),
});

export type SkillState = z.infer<typeof skillStateSchema>;

export const extensionsConfigSchema = z.object({
  mcpServers: z.record(z.string(), mcpServerConfigSchema).default({}),
  skills: z.record(z.string(), skillStateSchema).default({}),
});

export type ExtensionsConfig = z.infer<typeof extensionsConfigSchema>;

export function createEmptyExtensionsConfig(): ExtensionsConfig {
  return { mcpServers: {}, skills: {} };
}

/**
 * 把 env/headers 值里的 `$VAR` / `${VAR}` 占位符替换为 process.env 中的实际值。
 *
 * 触发条件：MCP server 配置常把密钥写成 `"$GITHUB_TOKEN"` 占位，连接前必须解析。
 * 后果：未解析的占位符替换为空字符串（对齐 deer-flow），而非保留字面 `$VAR`，
 * 避免把无意义字面量传给子进程或请求头。
 */
export function resolveEnvPlaceholders(
  source: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!source) return out;
  for (const [key, value] of Object.entries(source)) {
    out[key] = value.replace(/\$\{?(\w+)\}?/g, (_, name: string) => process.env[name] ?? '');
  }
  return out;
}
