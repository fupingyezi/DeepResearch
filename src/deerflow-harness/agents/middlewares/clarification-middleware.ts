import { createMiddleware } from 'langchain';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';

/**
 * ClarificationMiddleware（位序 13 / 始终最后）
 *
 * 与 `ask_clarification` 工具配合实现"按需 clarification"流程：
 *
 *   1) Lead agent 发现需要用户澄清 → 调用 `ask_clarification(question, details?)`。
 *   2) 工具 handler 内部通过 LangGraph custom writer 推送 `human_interrupt` 事件，
 *      并返回一条占位 ToolMessage 写回历史。
 *   3) 本中间件在**下一次** model 调用前（wrapModelCall）侦测到 messages 末尾
 *      存在 ask_clarification 的 ToolMessage，则直接返回一条不带 tool_calls
 *      的 AIMessage **跳过本次模型调用**，使图收敛到 END，等待用户的下一条消息。
 *
 * 设计要点：
 * - 不实现 `service.resume()`：用户回答 = 普通的下一轮 chat，checkpointer 自然续上。
 * - 该 middleware 必须排在所有 middleware **之后**（位序 13），确保上游已完成
 *   tool error / dangling fix 等修复，再做最终的"收尾决策"。
 */

const ASK_CLARIFICATION_TOOL_NAME = 'ask_clarification';

/** 检查 messages 末尾是否存在尚未被消费的 ask_clarification ToolMessage。 */
function hasPendingClarification(messages: readonly BaseMessage[]): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;

  // 从末尾向前扫到最近一条 AIMessage（含 tool_calls）；途中所有 ToolMessage
  // 都属于该 AIMessage 的回包。如果其中任意一条 name === ask_clarification
  // 且对应 AIMessage 在历史中只出现一次，即认为 pending（尚未在更后面被
  // 一轮新的 ai 文本/tool_call 消费）。
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m instanceof ToolMessage) {
      if ((m.name ?? '') === ASK_CLARIFICATION_TOOL_NAME) return true;
      // 其它工具的 ToolMessage：继续向前找成对的 AIMessage
      continue;
    }
    if (AIMessage.isInstance(m)) {
      // 找到最近的 AIMessage 即返回判定结果（前面没有 ask_clarification 的话）
      return false;
    }
  }
  return false;
}

export const clarificationMiddleware = createMiddleware({
  name: 'ClarificationMiddleware',

  /**
   * 拦截下一轮 model 调用：若上一轮 lead-agent 调用了 ask_clarification，
   * 直接合成"等待用户澄清"的最终 AIMessage 并跳过实际模型请求。
   *
   * handler 不被调用 → 不消耗 token；返回的 AIMessage 没有 tool_calls，
   * react-agent 检测到后会停在 END。
   */
  wrapModelCall: async (request, handler) => {
    if (hasPendingClarification(request.messages)) {
      console.info(
        '[ClarificationMiddleware] pending clarification detected — short-circuit model call',
      );
      return new AIMessage({
        content:
          '我已经把澄清问题抛给你了，请在上方决策面板中作答。' +
          '我会根据你的回复继续推进研究。',
        tool_calls: [],
      });
    }
    return handler(request);
  },
});
