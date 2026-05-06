/**
 * StreamProcessor - 流处理模块
 *
 * 封装 LangChain/LangGraph 的 streamEvents 调用逻辑，
 * 内部使用 EventStreamAdapter 进行事件转换。
 */

import {
  AgentEvent,
  AgentEventStream,
} from "@/types/agent-event";
import {
  EventStreamAdapter,
  EventStreamAdapterConfig,
} from "../event-stream/event-stream-adapter";
import { EventFilterConfig } from "../event-stream/event-filter-config";

/**
 * StreamProcessor 配置
 */
export interface StreamProcessorConfig {
  /** Agent 标识 */
  agentId: string;
  /** 事件过滤配置 */
  filter?: EventFilterConfig;
  /** 已知的工作流节点名称 */
  workflowNodeNames?: string[];
}

/**
 * StreamProcessor
 *
 * 封装 streamEvents 调用，将 LangChain Runnable 的事件流转换为 AgentEvent 流
 */
export class StreamProcessor {
  private config: StreamProcessorConfig;
  private adapter: EventStreamAdapter;

  constructor(config: StreamProcessorConfig) {
    this.config = config;
    this.adapter = new EventStreamAdapter({
      agentId: config.agentId,
      filter: config.filter,
      workflowNodeNames: config.workflowNodeNames,
    });
  }

  /**
   * 处理 LangChain Runnable 的 streamEvents 流
   *
   * @param runnable - LangChain Runnable 实例（Agent / StateGraph 编译后的实例）
   * @param input - 输入数据
   * @param options - streamEvents 的配置选项
   * @returns AgentEvent 异步生成器
   */
  async *processStreamEvents(
    runnable: any,
    input: any,
    options?: {
      configurable?: Record<string, any>;
      recursionLimit?: number;
      version?: "v2";
      metadata?: Record<string, any>;
    },
  ): AgentEventStream {
    const streamEventsOptions = {
      version: "v2" as const,
      ...options,
    };

    const eventStream = runnable.streamEvents(input, streamEventsOptions);

    yield* this.adapter.adaptStreamEvents(eventStream);
  }

  /**
   * 处理已有的 LangChain 事件流（不需要调用 streamEvents）
   *
   * @param eventStream - 已有的 LangChain 事件流
   * @returns AgentEvent 异步生成器
   */
  async *processExistingStream(
    eventStream: AsyncIterable<any>,
  ): AgentEventStream {
    yield* this.adapter.adaptStreamEvents(eventStream);
  }

  /**
   * 获取内部的 EventStreamAdapter 实例
   * 用于注入自定义事件等高级操作
   */
  getAdapter(): EventStreamAdapter {
    return this.adapter;
  }

  /**
   * 更新事件过滤配置
   */
  updateFilter(filter: EventFilterConfig): void {
    this.adapter = new EventStreamAdapter({
      agentId: this.config.agentId,
      filter,
      workflowNodeNames: this.config.workflowNodeNames,
    });
  }
}
