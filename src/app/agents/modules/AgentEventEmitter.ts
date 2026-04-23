/**
 * AgentEventEmitter - 事件发射模块
 *
 * 提供统一的 emit(event) 方法，内部维护一个异步事件队列，
 * 支持通过 AsyncGenerator 消费事件。
 */

import {
  AgentEvent,
  AgentEventType,
  AgentEventMetadata,
  AgentEventStream,
  createAgentEvent,
  LifecycleEvent,
  ErrorEvent,
} from "@/types/agentEvent";

/**
 * 事件发射器
 *
 * 使用方式：
 * 1. 通过 emit() 推入事件
 * 2. 通过 getStream() 获取异步生成器消费事件
 * 3. 通过 close() 关闭事件流
 */
export class AgentEventEmitter {
  private agentId: string;
  private metadata?: AgentEventMetadata;
  /** 事件队列 */
  private queue: AgentEvent[] = [];
  /** 等待事件的 resolve 回调 */
  private waitResolve: ((value: void) => void) | null = null;
  /** 流是否已关闭 */
  private closed = false;

  constructor(agentId: string, metadata?: AgentEventMetadata) {
    this.agentId = agentId;
    this.metadata = metadata;
  }

  /**
   * 发射一个事件到事件队列
   */
  emit(event: AgentEvent): void {
    if (this.closed) return;
    this.queue.push(event);
    // 如果有消费者在等待，通知它
    if (this.waitResolve) {
      this.waitResolve();
      this.waitResolve = null;
    }
  }

  /**
   * 快捷方法：发射生命周期 start 事件
   */
  emitStart(): void {
    this.emit(
      createAgentEvent<LifecycleEvent>(
        AgentEventType.LIFECYCLE,
        this.agentId,
        { stage: "start", timestamp: Date.now() },
        this.metadata,
      ),
    );
  }

  /**
   * 快捷方法：发射生命周期 done 事件
   */
  emitDone(): void {
    this.emit(
      createAgentEvent<LifecycleEvent>(
        AgentEventType.LIFECYCLE,
        this.agentId,
        { stage: "done", timestamp: Date.now() },
        this.metadata,
      ),
    );
  }

  /**
   * 快捷方法：发射错误事件
   */
  emitError(
    errorCode: string,
    errorMessage: string,
    recoverable = false,
  ): void {
    this.emit(
      createAgentEvent<ErrorEvent>(
        AgentEventType.ERROR,
        this.agentId,
        { errorCode, errorMessage, recoverable },
        this.metadata,
      ),
    );
  }

  /**
   * 关闭事件流
   */
  close(): void {
    this.closed = true;
    // 唤醒等待中的消费者
    if (this.waitResolve) {
      this.waitResolve();
      this.waitResolve = null;
    }
  }

  /**
   * 获取事件流（异步生成器）
   */
  async *getStream(): AgentEventStream {
    while (true) {
      // 消费队列中的所有事件
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }

      // 如果已关闭且队列为空，结束
      if (this.closed) break;

      // 等待新事件
      await new Promise<void>((resolve) => {
        this.waitResolve = resolve;
      });
    }
  }
}
