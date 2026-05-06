/**
 * EventConsumer - 前端统一事件消费层
 *
 * 解析 SSE data: 行为 AgentEvent 对象，根据 eventType 分发到注册的 Handler。
 * 消除 StreamChatHandler 中针对不同模式的条件分支逻辑。
 */

import {
  AgentEvent,
  AgentEventType,
  LlmStreamPayload,
  LlmCompletePayload,
  StateUpdatePayload,
  TaskProgressPayload,
  NodeEnterPayload,
  NodeExitPayload,
  HumanInterruptPayload,
  HumanResumePayload,
  ErrorPayload,
  LifecyclePayload,
  ToolCallStartPayload,
  ToolCallResultPayload,
} from "@/types/agentEvent";

/** 事件处理器回调类型 */
export type EventHandler<T = any> = (
  payload: T,
  event: AgentEvent,
) => void;

/** 事件处理器注册表类型 */
type HandlerRegistry = Map<string, Set<EventHandler>>;

/**
 * LlmStreamHandler - 处理 LLM 流式文本
 *
 * 将文本增量追加到消息内容中
 */
export function createLlmStreamHandler(
  onText: (text: string, reasoning?: string) => void,
): EventHandler<LlmStreamPayload> {
  return (payload) => {
    onText(payload.text, payload.reasoning);
  };
}

/**
 * LlmCompleteHandler - 处理 LLM 完成事件
 */
export function createLlmCompleteHandler(
  onComplete: (payload: LlmCompletePayload) => void,
): EventHandler<LlmCompletePayload> {
  return (payload) => {
    onComplete(payload);
  };
}

/**
 * StateUpdateHandler - 处理状态变更事件
 *
 * 根据 stateType 分发到不同的状态更新逻辑
 */
export function createStateUpdateHandler(handlers: {
  onSimpleAnalysis?: (data: any) => void;
  onTasksInitial?: (data: any) => void;
  onTaskUpdate?: (data: any) => void;
  onReport?: (data: any) => void;
  onResearchTarget?: (data: any) => void;
  onCustom?: (data: any) => void;
}): EventHandler<StateUpdatePayload> {
  return (payload) => {
    switch (payload.stateType) {
      case "simple_analysis":
        handlers.onSimpleAnalysis?.(payload.data);
        break;
      case "tasks_initial":
        handlers.onTasksInitial?.(payload.data);
        break;
      case "task_update":
        handlers.onTaskUpdate?.(payload.data);
        break;
      case "report":
        handlers.onReport?.(payload.data);
        break;
      case "research_target":
        handlers.onResearchTarget?.(payload.data);
        break;
      case "custom":
        handlers.onCustom?.(payload.data);
        break;
    }
  };
}

/**
 * TaskProgressHandler - 处理任务进度事件
 */
export function createTaskProgressHandler(
  onProgress: (payload: TaskProgressPayload) => void,
): EventHandler<TaskProgressPayload> {
  return (payload) => {
    onProgress(payload);
  };
}

/**
 * NodeEventHandler - 处理节点进入/退出事件
 */
export function createNodeEventHandler(handlers: {
  onNodeEnter?: (payload: NodeEnterPayload) => void;
  onNodeExit?: (payload: NodeExitPayload) => void;
}): {
  enterHandler: EventHandler<NodeEnterPayload>;
  exitHandler: EventHandler<NodeExitPayload>;
} {
  return {
    enterHandler: (payload) => handlers.onNodeEnter?.(payload),
    exitHandler: (payload) => handlers.onNodeExit?.(payload),
  };
}

/**
 * HumanInterruptHandler - 处理人工中断事件
 */
export function createHumanInterruptHandler(
  onInterrupt: (payload: HumanInterruptPayload) => void,
): EventHandler<HumanInterruptPayload> {
  return (payload) => {
    onInterrupt(payload);
  };
}

/**
 * LifecycleHandler - 处理生命周期事件
 */
export function createLifecycleHandler(handlers: {
  onStart?: (payload: LifecyclePayload) => void;
  onDone?: (payload: LifecyclePayload) => void;
}): EventHandler<LifecyclePayload> {
  return (payload) => {
    if (payload.stage === "start") {
      handlers.onStart?.(payload);
    } else if (payload.stage === "done") {
      handlers.onDone?.(payload);
    }
  };
}

/**
 * ErrorHandler - 处理错误事件
 */
export function createErrorHandler(
  onError: (payload: ErrorPayload) => void,
): EventHandler<ErrorPayload> {
  return (payload) => {
    onError(payload);
  };
}

/**
 * ToolCallHandler - 处理工具调用事件
 */
export function createToolCallHandler(handlers: {
  onToolStart?: (payload: ToolCallStartPayload) => void;
  onToolResult?: (payload: ToolCallResultPayload) => void;
}): {
  startHandler: EventHandler<ToolCallStartPayload>;
  resultHandler: EventHandler<ToolCallResultPayload>;
} {
  return {
    startHandler: (payload) => handlers.onToolStart?.(payload),
    resultHandler: (payload) => handlers.onToolResult?.(payload),
  };
}

/**
 * EventConsumer - 统一事件消费器
 *
 * 使用方式：
 * ```ts
 * const consumer = new EventConsumer();
 *
 * // 注册处理器
 * consumer.registerHandler(AgentEventType.LLM_STREAM, createLlmStreamHandler(...));
 * consumer.registerHandler(AgentEventType.STATE_UPDATE, createStateUpdateHandler(...));
 *
 * // 处理 SSE 流
 * await consumer.consumeSSEStream(reader);
 * ```
 */
export class EventConsumer {
  private handlers: HandlerRegistry = new Map();
  /** 流是否已完成 */
  private completed = false;

  /**
   * 注册事件处理器
   *
   * @param eventType 事件类型
   * @param handler 处理器回调
   */
  registerHandler(eventType: AgentEventType | string, handler: EventHandler): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);
  }

  /**
   * 取消注册事件处理器
   */
  unregisterHandler(eventType: AgentEventType | string, handler: EventHandler): void {
    this.handlers.get(eventType)?.delete(handler);
  }

  /**
   * 消费 SSE 流
   *
   * 使用 buffer 机制处理跨 chunk 的不完整数据行，
   * 确保大事件（如 STATE_UPDATE）不会因 TCP 分包而丢失。
   *
   * @param reader - ReadableStreamDefaultReader
   * @returns Promise<void>
   */
  async consumeSSEStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<void> {
    this.completed = false;
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += new TextDecoder().decode(value);

        // 按双换行符分割完整的 SSE 消息块
        const messages = buffer.split("\n\n");
        // 最后一个元素可能是不完整的，保留在 buffer 中
        buffer = messages.pop() || "";

        for (const message of messages) {
          const lines = message.split("\n");
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(6));
                this.dispatchEvent(data as AgentEvent);

                // 检查是否为 lifecycle done 事件
                if (
                  data.eventType === AgentEventType.LIFECYCLE &&
                  data.payload?.stage === "done"
                ) {
                  this.completed = true;
                }
              } catch (parseError) {
                console.error("EventConsumer JSON 解析错误:", parseError);
              }
            }
          }
        }

        if (this.completed) break;
      }

      // 处理 buffer 中可能残留的最后一条消息
      if (buffer.trim()) {
        const lines = buffer.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              this.dispatchEvent(data as AgentEvent);
            } catch {
              // 最后的残留数据解析失败，忽略
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * 处理单个 SSE data 行（用于兼容现有的逐行解析逻辑）
   *
   * @param data 解析后的 JSON 数据
   * @returns 是否为结束事件
   */
  handleSSEData(data: any): boolean {
    this.dispatchEvent(data as AgentEvent);

    // 检查是否为 lifecycle done 事件
    if (
      data.eventType === AgentEventType.LIFECYCLE &&
      data.payload?.stage === "done"
    ) {
      return true;
    }

    // 检查是否为错误事件
    if (data.eventType === AgentEventType.ERROR) {
      return true;
    }

    return false;
  }

  /**
   * 分发事件到注册的处理器
   */
  private dispatchEvent(event: AgentEvent): void {
    if (!event || !event.eventType) return;

    const handlers = this.handlers.get(event.eventType);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event.payload, event);
        } catch (error) {
          console.error(
            `EventConsumer handler error for ${event.eventType}:`,
            error,
          );
        }
      }
    }

    // 通配符处理器
    const wildcardHandlers = this.handlers.get("*");
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          handler(event.payload, event);
        } catch (error) {
          console.error("EventConsumer wildcard handler error:", error);
        }
      }
    }
  }

  /**
   * 检查流是否已完成
   */
  isCompleted(): boolean {
    return this.completed;
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.completed = false;
  }

  /**
   * 清除所有处理器
   */
  clearHandlers(): void {
    this.handlers.clear();
  }
}
