import { BaseAgentServer } from "./BaseAgentServer";

/**
 * Agent类型枚举
 */
export enum AgentType {
  BASIC = "basic",
  SEARCH = "search",
  DEEP_RESEARCH = "deep_research",
}

/**
 * Agent工厂函数类型
 */
type AgentFactory = () => BaseAgentServer;

/**
 * Agent管理器
 * 单例模式，负责Agent实例的创建和管理
 */
export class AgentManager {
  private static instance: AgentManager;
  private agents: Map<AgentType, BaseAgentServer> = new Map();
  private factories: Map<AgentType, AgentFactory> = new Map();

  private constructor() {
    // 私有构造函数，防止外部实例化
  }

  /**
   * 获取AgentManager单例
   */
  static getInstance(): AgentManager {
    if (!AgentManager.instance) {
      AgentManager.instance = new AgentManager();
    }
    return AgentManager.instance;
  }

  /**
   * 注册Agent工厂函数
   * @param type Agent类型
   * @param factory 工厂函数
   */
  registerFactory(type: AgentType, factory: AgentFactory): void {
    this.factories.set(type, factory);
  }

  /**
   * 获取Agent实例
   * 如果实例不存在则创建，否则返回缓存的实例
   * @param type Agent类型
   * @returns Agent实例
   */
  getAgent(type: AgentType): BaseAgentServer {
    if (!this.agents.has(type)) {
      const factory = this.factories.get(type);
      if (!factory) {
        throw new Error(
          `Unknown agent type: ${type}. Please register the factory first.`,
        );
      }
      this.agents.set(type, factory());
    }
    return this.agents.get(type)!;
  }
}
