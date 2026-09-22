/**
 * MCP / skill 扩展域服务。
 *
 * 配置不变量（与 deer-flow 对齐）：
 * - MCP 配置写入后必须 resetMcpClient()——DeerFlowClient 按「启用 server
 *   配置签名」缓存 MCP 客户端，不失效的话下轮对话仍用旧工具集
 * - mcpServerConfigSchema 的校验在这里做（route 只校验 name 形状）：
 *   schema 是 harness 的单一出处，app 层不复刻一份
 *
 * 错误映射：
 * - MCP server 不存在（setMcpServerEnabled 抛 `MCP server 'x' not found`）
 *   → EXTENSION_NOT_FOUND(404)
 * - createCustomSkill 的全部失败（frontmatter 缺失 / 名称不符等）
 *   → INVALID_INPUT(400)，与现状一致
 */

import {
  createCustomSkill,
  getExtensionsConfigStore,
  loadSkills,
  mcpServerConfigSchema,
  resetMcpClient,
  type ExtensionsConfigStore,
  type McpServerConfig,
  type Skill,
} from '@/deerflow-harness';
import { AppError } from '@/server/http';

export interface ExtensionServiceDeps {
  store: ExtensionsConfigStore;
  loadSkills: typeof loadSkills;
  createCustomSkill: typeof createCustomSkill;
  resetMcpClient: typeof resetMcpClient;
}

export class ExtensionService {
  constructor(private readonly deps: ExtensionServiceDeps) {}

  /** 全部 MCP 服务器配置（不解析 env 占位，原样返回供编辑）。 */
  async listMcpServers(): Promise<Record<string, McpServerConfig>> {
    const config = await this.deps.store.load();
    return config.mcpServers;
  }

  /** 新增或更新一个 MCP 服务器配置；成功后失效 MCP 客户端缓存。 */
  async upsertMcpServer(name: string, rawConfig: unknown): Promise<McpServerConfig> {
    const parsed = mcpServerConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new AppError('Invalid MCP server config', 'INVALID_INPUT', 400);
    }

    const config = await this.deps.store.setMcpServer(name, parsed.data);
    await this.deps.resetMcpClient();
    return config.mcpServers[name];
  }

  /** 切换 MCP 服务器启用状态；server 不存在 → EXTENSION_NOT_FOUND。 */
  async setMcpServerEnabled(name: string, enabled: boolean): Promise<McpServerConfig> {
    let config;
    try {
      config = await this.deps.store.setMcpServerEnabled(name, enabled);
    } catch (e) {
      if (e instanceof Error && e.message.includes('not found')) {
        throw new AppError(`MCP server '${name}' not found`, 'EXTENSION_NOT_FOUND', 404);
      }
      throw e;
    }
    await this.deps.resetMcpClient();
    return config.mcpServers[name];
  }

  /** 删除 MCP 服务器配置；成功后失效 MCP 客户端缓存。 */
  async removeMcpServer(name: string): Promise<void> {
    await this.deps.store.removeMcpServer(name);
    await this.deps.resetMcpClient();
  }

  /** 全部 skill（public + custom，含 enabled 状态）。 */
  async listSkills(): Promise<Skill[]> {
    return this.deps.loadSkills();
  }

  /**
   * 新建自定义 skill（写入 skills/custom/<name>/SKILL.md）。
   * 失败原因（frontmatter 缺失 / 名称不符 / 名称非法）一律 400——现状如此，
   * 设置页的表单校验应在上送前兜住大部分，这里只保证错误体统一。
   */
  async createSkill(name: string, content: string): Promise<Skill> {
    try {
      return await this.deps.createCustomSkill({ name, content });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Create skill failed';
      throw new AppError(message, 'INVALID_INPUT', 400);
    }
  }

  /** 切换 skill 启用状态。 */
  async setSkillEnabled(name: string, enabled: boolean): Promise<unknown> {
    const config = await this.deps.store.setSkillEnabled(name, enabled);
    return config.skills[name];
  }
}

const defaultDeps: ExtensionServiceDeps = {
  store: getExtensionsConfigStore(),
  loadSkills,
  createCustomSkill,
  resetMcpClient,
};

/**
 * 工厂 + 模块级懒单例。无跨请求可变状态（配置在 extensions_config.json +
 * harness 的 MCP 客户端缓存），模块级单例即可，无需 globalThis。
 */
export function createExtensionService(deps: ExtensionServiceDeps = defaultDeps): ExtensionService {
  return new ExtensionService(deps);
}

let _extensionService: ExtensionService | null = null;
export function getExtensionService(): ExtensionService {
  if (!_extensionService) _extensionService = createExtensionService();
  return _extensionService;
}
