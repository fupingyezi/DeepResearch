/**
 * InMemoryRunEventBus —— RunEventBus 的进程内实现：直包 StreamBridge。
 *
 * publish / subscribe 原样透传，晚订阅回放 ThreadChannel buffer（不丢不重的
 * 快照 + pending 语义都在 ThreadChannel 里）；release → drop()，回收已 close 的
 * channel 内存，调用方须保证订阅全部结束后再释放。fromEventId 忽略：断点续读
 * 依赖事件 ID，进程内无此概念。
 */

import type { ClientAgentEvent } from '../sse/client-event';
import { streamBridge, type StreamBridge } from '../stream-bridge';
import type { RunEventBus } from '../contracts';

export class InMemoryRunEventBus implements RunEventBus {
  constructor(private readonly bridge: StreamBridge = streamBridge) {}

  publish(threadId: string, runId: string, event: ClientAgentEvent): Promise<void> {
    this.bridge.channel(threadId, runId).publish(event);
    return Promise.resolve();
  }

  subscribe(
    threadId: string,
    runId: string,
    fromEventId?: string,
  ): AsyncIterable<ClientAgentEvent> {
    // 进程内无事件 ID 概念，fromEventId 不参与回放语义
    void fromEventId;
    return this.bridge.channel(threadId, runId).subscribe();
  }

  release(threadId: string, runId: string): Promise<void> {
    this.bridge.drop(threadId, runId);
    return Promise.resolve();
  }

  isDistributed(): boolean {
    return false;
  }
}
