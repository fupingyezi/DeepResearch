/**
 * AssistantPartsCollector（后端专用薄壳）
 *
 * 在 `src/app/api/v3/chat/route.ts` 的 wrapWithPersistence 中使用：
 *  - 流式过程中逐事件 onEvent，把 SSE 聚合成不可变 PartsState
 *  - 流结束时 finalize() 执行 task_summary / artifact 标记抽取，返回落库结构
 *
 * resume 续写：传入中断时落库的既有 parts 作为 seed，重建 toolCallId / taskId
 * 索引。这样 resume 流里 ask_clarification 的 TOOL_RESULT 能凭 toolCallId 命中
 * 既有 tool_call part（把 status running → done），并把续跑产出的最终答案追加到
 * 同一条 assistant 消息，避免重新加载时停在「请求澄清」转圈、丢失最终结果。
 */

import type { ClientAgentEvent } from '@deerflow-harness/runtime/sse/client-event';
import type { ChatMessageType, MessagePart } from '@/types';
import {
  createPartsStateFromExisting,
  finalizePartsState,
  initialPartsState,
  makeCancelledPart,
  reducePartsState,
  type PartsState,
} from './parts-reducer';

export class AssistantPartsCollector {
  private state: PartsState;

  /**
   * @param seedParts resume 续写时传入中断快照消息的既有 parts；
   *                  普通发送 / recall / reEditCall 不传，从空状态开始累积。
   */
  constructor(seedParts?: readonly MessagePart[]) {
    this.state =
      seedParts && seedParts.length > 0
        ? createPartsStateFromExisting(seedParts)
        : initialPartsState;
  }

  onEvent(event: ClientAgentEvent): void {
    this.state = reducePartsState(this.state, event);
  }

  /**
   * 收尾：抽 task_summary / artifact 后返回落库结构。
   *
   * @param cancelledText 本轮被取消时的标记文案（用户已取消 / 已被新消息取代）。
   *   传了就在**最末**补一条 cancelled part —— 放在 finalize 之后追加，是因为
   *   task_summary / artifact 是 finalize 时补到末尾的，标记必须排在它们之后才符合
   *   「正文 → 总结 → 本轮到哪儿结束」的阅读顺序。parts 为空则忽略，保持
   *   「没有任何内容就不落一条空消息」的既有规则。
   */
  finalize(
    fallbackTitle = '',
    cancelledText?: string | null,
  ): { parts: MessagePart[]; interrupt: ChatMessageType['interrupt'] } {
    const { parts, interrupt } = finalizePartsState(this.state, fallbackTitle);
    if (!cancelledText || parts.length === 0) return { parts, interrupt };
    return { parts: [...parts, makeCancelledPart(cancelledText)], interrupt };
  }
}
