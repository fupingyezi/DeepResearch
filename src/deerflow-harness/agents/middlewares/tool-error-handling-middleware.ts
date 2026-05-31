import { createMiddleware } from 'langchain';
import { ToolMessage } from '@langchain/core/messages';
import { isGraphBubbleUp } from '@langchain/langgraph';

/**
 * ToolErrorHandlingMiddleware（始终启用）
 *
 * 职责：
 * - 通过 wrapToolCall 捕获工具执行异常，转换为带 status='error' 的 ToolMessage，
 *   防止整个 graph 因单次工具失败而中断。
 * - 透传 LangGraph 控制流信号（GraphBubbleUp 系：interrupt/pause/resume/parent command），
 *   它们必须冒泡到 graph runtime 处理，不可被吞。
 */

const MISSING_TOOL_CALL_ID = 'missing_tool_call_id';
const MAX_DETAIL_LENGTH = 500;

/** 截断过长的错误细节，避免 ToolMessage 体积膨胀。 */
function truncateDetail(detail: string): string {
  if (detail.length <= MAX_DETAIL_LENGTH) return detail;
  return detail.slice(0, MAX_DETAIL_LENGTH - 3) + '...';
}

/** 从未知错误中提取人类可读的描述与构造器名（用于日志/反馈给模型）。 */
function describeError(err: any): { className: string; detail: string } {
  if (err instanceof Error) {
    const className = err.constructor?.name || 'Error';
    const detail = truncateDetail((err.message || '').trim() || className);
    return { className, detail };
  }
  // 非 Error 抛出物（字符串/对象/数字等）
  let detail: string;
  try {
    detail = typeof err === 'string' ? err : JSON.stringify(err);
  } catch {
    detail = String(err);
  }
  return { className: 'NonError', detail: truncateDetail(detail.trim() || 'NonError') };
}

export const toolErrorHandlingMiddleware = createMiddleware({
  name: 'ToolErrorHandlingMiddleware',

  wrapToolCall: async (request, handler) => {
    try {
      return await handler(request);
    } catch (err) {
      // 保留 LangGraph 控制流信号（interrupt / pause / resume / parent-command）。
      if (isGraphBubbleUp(err)) {
        throw err;
      }

      const toolName = String(request.toolCall.name || 'unknown_tool');
      const toolCallId = String(request.toolCall.id || MISSING_TOOL_CALL_ID);
      const { className, detail } = describeError(err);

      console.error(
        `[ToolErrorHandlingMiddleware] Tool execution failed: name=${toolName} id=${toolCallId} (${className}: ${detail})`,
      );

      const content =
        `Error: Tool '${toolName}' failed with ${className}: ${detail}. ` +
        `Continue with available context, or choose an alternative tool.`;

      return new ToolMessage({
        content,
        tool_call_id: toolCallId,
        name: toolName,
        status: 'error',
      });
    }
  },
});
