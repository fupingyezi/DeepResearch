/**
 * EventStreamAdapter
 *
 * 将 LangChain/LangGraph 的 streamEvents v2 原生事件映射为统一的 AgentEvent 格式。
 * 支持事件过滤、自定义事件注入。
 *
 * LangChain streamEvents v2 事件类型参考：
 * - on_chat_model_start / on_chat_model_stream / on_chat_model_end
 * - on_tool_start / on_tool_end
 * - on_chain_start / on_chain_end
 * - on_custom_event（自定义事件）
 */

import {
  AgentEvent,
  AgentEventType,
  AgentEventMetadata,
  createAgentEvent,
  LlmStreamEvent,
  LlmCompleteEvent,
  ToolCallStartEvent,
  ToolCallResultEvent,
  NodeEnterEvent,
  NodeExitEvent,
  ErrorEvent,
  TaskProgressEvent,
  StateUpdateEvent,
  HumanInterruptEvent,
  SubAgentDispatchEvent,
  HarnessLifecycleEvent,
} from "@/types/agent-event";
import { EventFilterConfig } from "./event-filter-config";

/**
 * LangChain streamEvents v2 事件结构
 */
interface LangChainStreamEvent {
  /** 事件类型，如 on_chat_model_stream */
  event: string;
  /** 事件名称（runnable 名称） */
  name: string;
  /** 运行 ID */
  run_id: string;
  /** 父运行 ID */
  parent_ids?: string[];
  /** 事件标签 */
  tags?: string[];
  /** 事件数据 */
  data: {
    /** 输入数据（start 事件） */
    input?: any;
    /** 输出数据（end 事件） */
    output?: any;
    /** 增量数据（stream 事件） */
    chunk?: any;
    [key: string]: any;
  };
  /** 事件元数据 */
  metadata?: Record<string, any>;
}

/**
 * EventStreamAdapter 配置
 */
export interface EventStreamAdapterConfig {
  /** Agent 标识 */
  agentId: string;
  /** 事件过滤配置 */
  filter?: EventFilterConfig;
  /** 事件元数据（会附加到每个事件上） */
  metadata?: AgentEventMetadata;
  /** 已知的工作流节点名称列表（用于识别 node_enter/node_exit 事件） */
  workflowNodeNames?: string[];
}

/**
 * EventStreamAdapter
 *
 * 核心适配器，将 LangChain streamEvents 映射为统一 AgentEvent
 */
export class EventStreamAdapter {
  private config: EventStreamAdapterConfig;
  /** 自定义事件注入队列 */
  private injectedEvents: AgentEvent[] = [];
  /** 已知的工作流节点名称集合 */
  private nodeNameSet: Set<string>;

  constructor(config: EventStreamAdapterConfig) {
    this.config = config;
    this.nodeNameSet = new Set(config.workflowNodeNames || []);
  }

  /**
   * 核心方法：将 LangChain streamEvents 流转换为 AgentEvent 流
   *
   * @param langchainEventStream - LangChain 的 streamEvents 返回的异步迭代器
   * @returns AgentEvent 异步生成器
   */
  async *adaptStreamEvents(
    langchainEventStream: AsyncIterable<LangChainStreamEvent>,
  ): AsyncGenerator<AgentEvent> {
    let rawEventCount = 0;
    try {
      for await (const lcEvent of langchainEventStream) {
        rawEventCount++;
        // 调试日志：直接打印 LangChain 原始事件对象
        if (rawEventCount <= 30) {
          const raw = JSON.stringify(lcEvent, null, 0);
          console.log(`[EventStreamAdapter] 📥 RAW LC事件 #${rawEventCount} (len=${raw.length}):`, raw.slice(0, 1500));
        } else if (rawEventCount === 31) {
          console.log(`[EventStreamAdapter] ... 后续事件省略日志输出 ...`);
        }

        // 先输出所有注入的自定义事件
        yield* this.flushInjectedEvents();

        // 应用过滤规则
        if (!this.shouldIncludeEvent(lcEvent)) {
          continue;
        }

        // 映射 LangChain 事件到 AgentEvent
        const agentEvents = this.mapLangChainEvent(lcEvent);
        for (const event of agentEvents) {
          yield event;
        }
      }

      // 流结束后，输出剩余的注入事件
      yield* this.flushInjectedEvents();
      console.log(`[EventStreamAdapter] 📊 LC事件流结束，共处理 ${rawEventCount} 个原始事件`);
    } catch (error: any) {
      yield createAgentEvent<ErrorEvent>(
        AgentEventType.ERROR,
        this.config.agentId,
        {
          errorCode: error.name || "StreamAdapterError",
          errorMessage:
            error.message || "Error in EventStreamAdapter processing",
          recoverable: false,
        },
        this.config.metadata,
      );
    }
  }

  /**
   * 注入自定义事件到事件流中
   * 用于注入 human_interrupt 等 LangChain 不原生支持的事件
   */
  injectCustomEvent(event: AgentEvent): void {
    this.injectedEvents.push(event);
  }

  /**
   * 动态添加工作流节点名称
   */
  addNodeName(name: string): void {
    this.nodeNameSet.add(name);
  }

  /**
   * 输出并清空注入事件队列
   */
  private *flushInjectedEvents(): Generator<AgentEvent> {
    while (this.injectedEvents.length > 0) {
      yield this.injectedEvents.shift()!;
    }
  }

  /**
   * 事件过滤：判断是否应该包含此事件
   */
  private shouldIncludeEvent(lcEvent: LangChainStreamEvent): boolean {
    const filter = this.config.filter;
    if (!filter) return true;

    // 按 tag 过滤
    if (filter.includeTags && filter.includeTags.length > 0) {
      const eventTags = lcEvent.tags || [];
      const hasMatchingTag = filter.includeTags.some((tag) =>
        eventTags.includes(tag),
      );
      if (!hasMatchingTag) return false;
    }

    // 按名称包含过滤
    if (filter.includeNames && filter.includeNames.length > 0) {
      if (!filter.includeNames.includes(lcEvent.name)) return false;
    }

    // 按名称排除过滤
    if (filter.excludeNames && filter.excludeNames.length > 0) {
      if (filter.excludeNames.includes(lcEvent.name)) return false;
    }

    // 按事件类型包含过滤
    if (filter.includeTypes && filter.includeTypes.length > 0) {
      if (!filter.includeTypes.includes(lcEvent.event)) return false;
    }

    // 按事件类型排除过滤
    if (filter.excludeTypes && filter.excludeTypes.length > 0) {
      if (filter.excludeTypes.includes(lcEvent.event)) return false;
    }

    return true;
  }

  /**
   * 将单个 LangChain 事件映射为一个或多个 AgentEvent
   */
  private mapLangChainEvent(lcEvent: LangChainStreamEvent): AgentEvent[] {
    const { event, name, data } = lcEvent;

    switch (event) {
      case "on_chat_model_stream":
        return this.handleLlmStream(lcEvent);

      case "on_chat_model_end":
        return this.handleLlmComplete(lcEvent);

      case "on_tool_start":
        return this.handleToolStart(lcEvent);

      case "on_tool_end":
        return this.handleToolEnd(lcEvent);

      case "on_chain_start":
        return this.handleChainStart(lcEvent);

      case "on_chain_end":
        return this.handleChainEnd(lcEvent);

      case "on_custom_event":
        return this.handleCustomEvent(lcEvent);

      default:
        return [];
    }
  }

  /**
   * 处理 LLM 流式输出事件
   *
   * 支持多种 AIMessageChunk 格式：
   * 1. chunk 为字符串（简单文本）
   * 2. chunk.content 为字符串（标准格式）
   * 3. chunk.content 为 ContentBlock[]（多模态/思考模型）
   * 4. chunk.additional_kwargs.reasoning_content（qwen 思考模型通过 OpenAI 兼容接口）
   */
  private handleLlmStream(lcEvent: LangChainStreamEvent): AgentEvent[] {
    let chunk = lcEvent.data?.chunk;
    if (!chunk) return [];

    // 处理 LangChain 序列化格式：{ lc: 1, type: "constructor", kwargs: { ... } }
    if (chunk.lc === 1 && chunk.type === "constructor" && chunk.kwargs) {
      chunk = chunk.kwargs;
    }

    // LangChain AIMessageChunk 的内容提取
    let text = "";
    let reasoning: string | undefined;

    if (typeof chunk === "string") {
      text = chunk;
    } else if (chunk.content !== undefined || chunk.additional_kwargs) {
      // AIMessageChunk.content 可能是 string 或 ContentBlock[]
      if (typeof chunk.content === "string") {
        text = chunk.content;
      } else if (Array.isArray(chunk.content)) {
        for (const block of chunk.content) {
          if (block.type === "text") {
            text += block.text || "";
          } else if (block.type === "thinking" || block.type === "reasoning") {
            reasoning = (reasoning || "") + (block.text || block.thinking || "");
          }
        }
      }

      // 支持 qwen 思考模型：reasoning_content 在 additional_kwargs 中
      // DashScope OpenAI 兼容接口返回的思考内容在此字段
      if (chunk.additional_kwargs?.reasoning_content) {
        reasoning = (reasoning || "") + chunk.additional_kwargs.reasoning_content;
      }
    }

    // 如果没有有效内容，跳过
    if (!text && !reasoning) return [];

    return [
      createAgentEvent<LlmStreamEvent>(
        AgentEventType.LLM_STREAM,
        this.config.agentId,
        { text, reasoning },
        this.config.metadata,
      ),
    ];
  }

  /**
   * 处理 LLM 完成事件
   */
  private handleLlmComplete(lcEvent: LangChainStreamEvent): AgentEvent[] {
    const output = lcEvent.data?.output;
    if (!output) return [];

    // 提取 usage 信息
    const usageMetadata = output.usage_metadata || output.response_metadata?.usage;
    let usage: LlmCompleteEvent["payload"]["usage"];

    if (usageMetadata) {
      usage = {
        inputTokens: usageMetadata.input_tokens || usageMetadata.prompt_tokens || 0,
        outputTokens: usageMetadata.output_tokens || usageMetadata.completion_tokens || 0,
        reasoningTokens: usageMetadata.reasoning_tokens,
        totalCost: usageMetadata.total_cost,
      };
    }

    return [
      createAgentEvent<LlmCompleteEvent>(
        AgentEventType.LLM_COMPLETE,
        this.config.agentId,
        {
          fullText: typeof output.content === "string" ? output.content : undefined,
          usage,
        },
        this.config.metadata,
      ),
    ];
  }

  /**
   * 处理工具调用开始事件
   */
  private handleToolStart(lcEvent: LangChainStreamEvent): AgentEvent[] {
    const input = lcEvent.data?.input;

    return [
      createAgentEvent<ToolCallStartEvent>(
        AgentEventType.TOOL_CALL_START,
        this.config.agentId,
        {
          toolCallId: lcEvent.run_id,
          toolName: lcEvent.name,
          arguments: typeof input === "string" ? input : JSON.stringify(input),
        },
        this.config.metadata,
      ),
    ];
  }

  /**
   * 处理工具调用结束事件
   */
  private handleToolEnd(lcEvent: LangChainStreamEvent): AgentEvent[] {
    const output = lcEvent.data?.output;

    return [
      createAgentEvent<ToolCallResultEvent>(
        AgentEventType.TOOL_CALL_RESULT,
        this.config.agentId,
        {
          toolCallId: lcEvent.run_id,
          toolName: lcEvent.name,
          result: output,
          success: true,
        },
        this.config.metadata,
      ),
    ];
  }

  /**
   * 处理 Chain 开始事件
   * 如果名称匹配已知的工作流节点，则映射为 node_enter 事件
   */
  private handleChainStart(lcEvent: LangChainStreamEvent): AgentEvent[] {
    if (!this.isWorkflowNode(lcEvent.name)) return [];

    return [
      createAgentEvent<NodeEnterEvent>(
        AgentEventType.NODE_ENTER,
        this.config.agentId,
        {
          nodeName: lcEvent.name,
          inputSummary: lcEvent.data?.input
            ? this.summarizeState(lcEvent.data.input)
            : undefined,
        },
        this.config.metadata,
      ),
    ];
  }

  /**
   * 处理 Chain 结束事件
   * 如果名称匹配已知的工作流节点，则映射为 node_exit 事件
   */
  private handleChainEnd(lcEvent: LangChainStreamEvent): AgentEvent[] {
    if (!this.isWorkflowNode(lcEvent.name)) return [];

    return [
      createAgentEvent<NodeExitEvent>(
        AgentEventType.NODE_EXIT,
        this.config.agentId,
        {
          nodeName: lcEvent.name,
          outputDelta: lcEvent.data?.output
            ? this.summarizeState(lcEvent.data.output)
            : undefined,
        },
        this.config.metadata,
      ),
    ];
  }

  /**
   * 处理自定义事件（通过 LangGraph 的 dispatchCustomEvent 发射）
   *
   * 支持的自定义事件名称：
   * - task_progress: 任务进度更新
   * - state_update: 状态变更
   * - human_interrupt: 人工中断
   * - sub_agent_dispatch: Sub-agent 调度事件
   * - harness_lifecycle: Harness 生命周期事件
   */
  private handleCustomEvent(lcEvent: LangChainStreamEvent): AgentEvent[] {
    const eventName = lcEvent.name;
    const eventData = lcEvent.data;

    switch (eventName) {
      case "task_progress":
        return [
          createAgentEvent<TaskProgressEvent>(
            AgentEventType.TASK_PROGRESS,
            this.config.agentId,
            {
              taskId: eventData?.taskId || "",
              description: eventData?.description,
              status: eventData?.status || "unknown",
              needSearch: eventData?.needSearch,
              searchResult: eventData?.searchResult,
              result: eventData?.result,
            },
            this.config.metadata,
          ),
        ];

      case "state_update":
        return [
          createAgentEvent<StateUpdateEvent>(
            AgentEventType.STATE_UPDATE,
            this.config.agentId,
            {
              stateType: eventData?.stateType || "custom",
              data: eventData?.data,
            },
            this.config.metadata,
          ),
        ];

      case "human_interrupt":
        return [
          createAgentEvent<HumanInterruptEvent>(
            AgentEventType.HUMAN_INTERRUPT,
            this.config.agentId,
            {
              question: eventData?.question || "",
              details: eventData?.details,
            },
            this.config.metadata,
          ),
        ];

      case "sub_agent_dispatch":
        return [
          createAgentEvent<SubAgentDispatchEvent>(
            AgentEventType.SUB_AGENT_DISPATCH,
            this.config.agentId,
            {
              subAgentName: eventData?.subAgentName || "",
              task: eventData?.task || "",
              status: eventData?.status || "dispatched",
              result: eventData?.result,
              errorMessage: eventData?.errorMessage,
              durationMs: eventData?.durationMs,
            },
            this.config.metadata,
          ),
        ];

      case "harness_lifecycle":
        return [
          createAgentEvent<HarnessLifecycleEvent>(
            AgentEventType.HARNESS_LIFECYCLE,
            this.config.agentId,
            {
              harnessId: eventData?.harnessId || "",
              phase: eventData?.phase || "execute",
              status: eventData?.status || "start",
              depth: eventData?.depth || 0,
              timestamp: eventData?.timestamp || Date.now(),
              errorMessage: eventData?.errorMessage,
            },
            this.config.metadata,
          ),
        ];

      default:
        // 未知的自定义事件，作为通用 state_update 处理
        return [
          createAgentEvent<StateUpdateEvent>(
            AgentEventType.STATE_UPDATE,
            this.config.agentId,
            {
              stateType: "custom",
              data: { eventName, ...eventData },
            },
            this.config.metadata,
          ),
        ];
    }
  }

  /**
   * 判断名称是否为已知的工作流节点
   */
  private isWorkflowNode(name: string): boolean {
    return this.nodeNameSet.has(name);
  }

  /**
   * 状态摘要：提取状态对象的关键字段，避免传输过大的数据
   */
  private summarizeState(state: any): Record<string, any> {
    if (!state || typeof state !== "object") return {};

    const summary: Record<string, any> = {};
    const MAX_STRING_LENGTH = 200;

    for (const [key, value] of Object.entries(state)) {
      if (value === null || value === undefined) continue;

      if (typeof value === "string") {
        summary[key] =
          value.length > MAX_STRING_LENGTH
            ? value.slice(0, MAX_STRING_LENGTH) + "..."
            : value;
      } else if (Array.isArray(value)) {
        summary[key] = `[Array(${value.length})]`;
      } else if (typeof value === "object") {
        summary[key] = "[Object]";
      } else {
        summary[key] = value;
      }
    }

    return summary;
  }
}
