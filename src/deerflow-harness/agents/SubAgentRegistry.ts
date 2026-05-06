/**
 * SubAgentRegistry - Sub-agent 注册表
 *
 * 单例模式，管理所有已注册的 Sub-agent 配置。
 * 支持动态注册/注销，以及将 Sub-agent 转换为 LangChain Tool。
 */

import { tool } from "langchain";
import z from "zod";
import { SubAgentConfig, ISubAgentRegistry } from "./subagent";

/**
 * SubAgentRegistry
 *
 * 维护一个 Map<string, SubAgentConfig> 存储所有已注册的 Sub-agent 配置。
 * 提供 toTools() 方法将 Sub-agent 转换为 LangChain DynamicStructuredTool。
 */
export class SubAgentRegistry implements ISubAgentRegistry {
  private static instance: SubAgentRegistry;
  private registry: Map<string, SubAgentConfig> = new Map();

  /** 工具创建回调（由 SubAgentDispatcher 注入） */
  private toolFactory: ((config: SubAgentConfig) => any) | null = null;

  private constructor() {}

  /**
   * 获取 SubAgentRegistry 单例
   */
  static getInstance(): SubAgentRegistry {
    if (!SubAgentRegistry.instance) {
      SubAgentRegistry.instance = new SubAgentRegistry();
    }
    return SubAgentRegistry.instance;
  }

  /**
   * 设置工具创建工厂函数
   *
   * 由 SubAgentDispatcher 调用，注入实际的 Sub-agent 调度逻辑。
   * 这样 toTools() 生成的 Tool 在被调用时，会通过 Dispatcher 创建独立 Harness 执行。
   */
  setToolFactory(factory: (config: SubAgentConfig) => any): void {
    this.toolFactory = factory;
  }

  /**
   * 注册一个 Sub-agent 配置
   */
  register(config: SubAgentConfig): void {
    if (this.registry.has(config.name)) {
      console.warn(
        `[SubAgentRegistry] Sub-agent "${config.name}" already registered, overwriting.`,
      );
    }
    this.registry.set(config.name, config);
    console.log(`[SubAgentRegistry] Registered sub-agent: ${config.name}`);
  }

  /**
   * 注销一个 Sub-agent
   */
  unregister(name: string): void {
    if (this.registry.delete(name)) {
      console.log(`[SubAgentRegistry] Unregistered sub-agent: ${name}`);
    }
  }

  /**
   * 获取指定名称的 Sub-agent 配置
   */
  get(name: string): SubAgentConfig | undefined {
    return this.registry.get(name);
  }

  /**
   * 获取所有已注册的 Sub-agent 配置
   */
  getAll(): SubAgentConfig[] {
    return Array.from(this.registry.values());
  }

  /**
   * 检查 Sub-agent 是否已注册
   */
  has(name: string): boolean {
    return this.registry.has(name);
  }

  /**
   * 获取已注册的 Sub-agent 数量
   */
  get size(): number {
    return this.registry.size;
  }

  /**
   * 将所有已注册的 Sub-agent 转换为 LangChain Tool 数组
   *
   * 如果已设置 toolFactory（由 SubAgentDispatcher 注入），
   * 则使用 toolFactory 创建具有实际调度能力的 Tool。
   * 否则创建占位 Tool（仅返回描述信息）。
   */
  toTools(): any[] {
    const tools: any[] = [];

    for (const config of this.registry.values()) {
      if (this.toolFactory) {
        // 使用 SubAgentDispatcher 注入的工厂函数创建 Tool
        tools.push(this.toolFactory(config));
      } else {
        // 创建占位 Tool（无实际调度能力）
        tools.push(this.createPlaceholderTool(config));
      }
    }

    return tools;
  }

  /**
   * 清除所有注册
   */
  clear(): void {
    this.registry.clear();
  }

  /**
   * 创建占位 Tool（当 toolFactory 未设置时使用）
   */
  private createPlaceholderTool(config: SubAgentConfig): any {
    return tool(
      async (input: { task: string }) => {
        return `[Sub-agent "${config.name}" placeholder] Task: ${input.task} - Tool factory not configured.`;
      },
      {
        name: `sub_agent_${config.name}`,
        description: config.description,
        schema: z.object({
          task: z.string().describe("要分配给此 Sub-agent 的任务描述"),
        }),
      },
    );
  }
}
