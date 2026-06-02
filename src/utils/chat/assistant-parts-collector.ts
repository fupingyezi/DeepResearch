/**
 * AssistantPartsCollector（后端专用薄壳）
 *
 * 在 `src/app/api/v3/chat/route.ts` 的 wrapWithPersistence 中使用：
 *  - 流式过程中逐事件 onEvent，把 SSE 聚合成不可变 PartsState
 *  - 流结束时 finalize() 执行 task_summary / artifact 标记抽取，返回落库结构
 */

import type { ClientAgentEvent } from '@deerflow-harness/runtime/sse/client-event';
import type { ChatMessageType, MessagePart } from '@/types';
import {
  finalizePartsState,
  initialPartsState,
  reducePartsState,
  type PartsState,
} from './parts-reducer';

export class AssistantPartsCollector {
  private state: PartsState = initialPartsState;

  onEvent(event: ClientAgentEvent): void {
    this.state = reducePartsState(this.state, event);
  }

  finalize(fallbackTitle = ''): { parts: MessagePart[]; interrupt: ChatMessageType['interrupt'] } {
    return finalizePartsState(this.state, fallbackTitle);
  }
}
