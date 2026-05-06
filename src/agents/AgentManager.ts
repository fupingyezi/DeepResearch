import { BaseAgentServer } from "./BaseAgentServer";
import { AgentEvent } from "@/types/agentEvent";
import { SubAgentConfig } from "@deerflow-harness/agents";
import { SubAgentRegistry } from "@deerflow-harness/agents";

/**
 * Agent 类型枚举
 */
export enum AgentType {
  BASIC = "basic",
  SEARCH = "search",
  DEEP_RESEARCH = "deep_research",
}

/**
 * Agent 工厂函数类型
 */
type AgentFactory = () => BaseAgentServer;

/**
 * 事件总线监听器类型
 */
type EventBusListener = (event: AgentEvent) => void;

/**
 * EventBus - 共享事件总线
 *
 * 支持 Agent 间通过事件通信
 */
export class EventBus {
  private listeners: Map<string, Set<EventBusListener>> = new Map();

  /**
   * 订阅事件
   * @param eventType 事件类型（或 '*' 订阅所有事件）
   * @param listener 监听器回调
   */
  on(eventType: string, listener: EventBusListener): void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(listener);
  }

  /**
   * 取消订阅
   */
  off(eventType: string, listener: EventBusListener): void {
    this.listeners.get(eventType)?.delete(listener);
  }

  /**
   * 发布事件
   */
  emit(event: AgentEvent): void {
    // 通知特定事件类型的监听器
    this.listeners.get(event.eventType)?.forEach((listener) => listener(event));
    // 通知通配符监听器
    this.listeners.get("*")?.forEach((listener) => listener(event));
  }

  /**
   * 清除所有监听器
   */
  clear(): void {
    this.listeners.clear();
  }
}

/**
 * AgentManager
 *
 * 单例模式，负责 Agent 实例的创建、管理和事件总线。
 * 支持动态注册/注销 Agent，提供基于事件的 Agent 间通信能力。
 */
export class AgentManager {
  private static instance: AgentManager;
  private agents: Map<AgentType, BaseAgentServer> = new Map();
  private factories: Map<AgentType, AgentFactory> = new Map();
  /** 共享事件总线 */
  private eventBus: EventBus;

  private constructor() {
    this.eventBus = new EventBus();
  }

  /**
   * 获取 AgentManager 单例
   */
  static getInstance(): AgentManager {
    if (!AgentManager.instance) {
      AgentManager.instance = new AgentManager();
    }
    return AgentManager.instance;
  }

  /**
   * 获取共享事件总线
   */
  getEventBus(): EventBus {
    return this.eventBus;
  }

  /**
   * 注册 Agent（v2 动态注册）
   *
   * @param type Agent 类型
   * @param factory 工厂函数
   */
  registerAgent(type: AgentType, factory: AgentFactory): void {
    this.factories.set(type, factory);
    // 如果已有旧实例，清除缓存以便下次获取时使用新工厂
    this.agents.delete(type);
  }

  /**
   * 注销 Agent
   *
   * @param type Agent 类型
   */
  unregisterAgent(type: AgentType): void {
    this.factories.delete(type);
    this.agents.delete(type);
  }

  /**
   * 获取 Agent 实例
   * 如果实例不存在则创建，否则返回缓存的实例
   *
   * @param type Agent 类型
   * @returns Agent 实例
   */
  getAgent(type: AgentType): BaseAgentServer {
    if (!this.agents.has(type)) {
      const factory = this.factories.get(type);
      if (!factory) {
        throw new Error(
          `Unknown agent type: ${type}. Please register the agent first.`,
        );
      }
      this.agents.set(type, factory());
    }
    return this.agents.get(type)!;
  }

  /**
   * 检查 Agent 是否已注册
   */
  hasAgent(type: AgentType): boolean {
    return this.factories.has(type);
  }

  /**
   * 获取所有已注册的 Agent 类型
   */
  getRegisteredTypes(): AgentType[] {
    return Array.from(this.factories.keys());
  }

  /**
   * 注册 Sub-agent 配置
   *
   * 将 Sub-agent 配置注册到 SubAgentRegistry，
   * Lead Agent 可通过 function calling 动态调度这些 Sub-agent。
   *
   * @param config Sub-agent 配置
   */
  registerSubAgent(config: SubAgentConfig): void {
    SubAgentRegistry.getInstance().register(config);
  }

  /**
   * 获取 Sub-agent 注册表
   *
   * @returns SubAgentRegistry 实例
   */
  getSubAgentRegistry(): SubAgentRegistry {
    return SubAgentRegistry.getInstance();
  }
}
