import { CreateModelOptions } from "@deerflow-harness/models";
import { AgentEventStream, AgentEvent } from "@/types/agentEvent";
import { AgentEventEmitter } from "./modules/AgentEventEmitter";
import { StreamProcessor } from "./modules/StreamProcessor";
import { EventFilterConfig } from "./eventStream/EventFilterConfig";

/**
 * Agent 配置接口
 */
export interface AgentConfig extends CreateModelOptions {
  systemPrompt: string;
  tools?: any[];
  checkpointer?: any;
}

/**
 * Agent 能力配置接口（声明式配置）
 *
 * 支持通过配置声明 Agent 的能力组合，而非硬编码
 */
export interface AgentCapabilityConfig {
  /** 是否需要工具 */
  tools?: any[];
  /** 是否使用 StateGraph 作为执行引擎 */
  useStateGraph?: boolean;
  /** 流模式 */
  streamMode?: "events" | "messages" | "values";
  /** 状态持久化 checkpointer */
  checkpointer?: any;
  /** 事件过滤配置 */
  eventFilter?: EventFilterConfig;
  /** 工作流节点名称列表（仅 StateGraph 模式使用） */
  workflowNodeNames?: string[];
}

/**
 * Agent 响应接口
 */
export interface AgentResponse {
  messages: any[];
  [key: string]: any;
}

/**
 * v2 Agent Handler 接口（事件驱动）
 */
export interface AgentHandler {
  createMessage(
    messages: any[],
    metadata?: { [key: string]: any },
  ): AgentEventStream;
  buildAgent(): void | Promise<void>;
  getConfig(): AgentConfig;
}

/**
 * BaseAgentServer - 组合模式 Agent 基类
 *
 * 核心能力通过可插拔模块提供：
 * - AgentEventEmitter: 事件发射
 * - StreamProcessor: 流处理（streamEvents 适配）
 *
 * 子类通过 capabilityConfig 声明式配置能力组合
 */
export abstract class BaseAgentServer implements AgentHandler {
  protected config: AgentConfig;
  protected capabilityConfig: AgentCapabilityConfig;

  /** 事件发射器模块 */
  protected emitter: AgentEventEmitter;
  /** 流处理器模块 */
  protected streamProcessor: StreamProcessor;

  constructor(
    config: AgentConfig,
    capabilityConfig?: AgentCapabilityConfig,
  ) {
    this.config = config;
    this.capabilityConfig = capabilityConfig || {};

    // 初始化组合模块
    const agentId = this.getAgentId();
    this.emitter = new AgentEventEmitter(agentId);
    this.streamProcessor = new StreamProcessor({
      agentId,
      filter: this.capabilityConfig.eventFilter,
      workflowNodeNames: this.capabilityConfig.workflowNodeNames,
    });
  }

  /**
   * 创建消息流（v2 事件驱动）
   * 返回统一的 AgentEvent 异步生成器
   */
  abstract createMessage(
    messages: any[],
    metadata?: { [key: string]: any },
  ): AgentEventStream;

  /**
   * 构建 Agent 实例
   */
  abstract buildAgent(): void | Promise<void>;

  /**
   * 获取 Agent 唯一标识
   * 子类可覆盖以提供自定义 ID
   */
  getAgentId(): string {
    return this.constructor.name;
  }

  /**
   * 获取 Agent 配置
   */
  getConfig(): AgentConfig {
    return { ...this.config };
  }

  /**
   * 获取能力配置
   */
  getCapabilityConfig(): AgentCapabilityConfig {
    return { ...this.capabilityConfig };
  }

  /**
   * 获取事件发射器
   */
  getEmitter(): AgentEventEmitter {
    return this.emitter;
  }

  /**
   * 获取流处理器
   */
  getStreamProcessor(): StreamProcessor {
    return this.streamProcessor;
  }
}
