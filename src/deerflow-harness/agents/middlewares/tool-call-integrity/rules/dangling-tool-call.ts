import {
  AIMessage,
  BaseMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import type { IntegrityRule } from '../types';

/**
 * DanglingToolCallRule
 *
 * 修复消息历史中"悬挂 tool_call"：AIMessage 上有 `tool_calls` 但缺少
 * 对应的 ToolMessage（用户中断 / 请求取消 / 流断开等）。下一次模型调用
 * 会因为消息格式不完整被供应商拒绝。
 *
 * 实现：扫描历史，对每个未配对的 `tool_call_id` 紧跟在产生它的 AIMessage
 * 之后插入一条 status='error' 的占位 ToolMessage —— 满足供应商对
 * "tool_call 必须紧邻 tool_result" 的格式契约。
 *
 * 与 UnknownToolCallRule 的协作：
 *  - 本规则只 *新增* ToolMessage，不修改 AIMessage；因此即便上游规则
 *    剔除了引用未知工具的 tool_call，本规则也不会再为其补占位
 *    （sanitizeAiMessage 会同时维护 tool_call/tool_result 一致性）。
 *  - 顺序约定：本规则在 UnknownToolCallRule **之后**执行，避免先为
 *    "未知工具"的 tool_call_id 补占位、再被上游规则当作孤立 ToolMessage
 *    清掉。
 */

interface NormalizedToolCall {
  id?: string;
  name: string;
}

interface RawToolCallPayload {
  id?: string;
  name?: string;
  function?: { name?: string };
}

/** 同时兼容标准化字段和 OpenAI 原生 raw 形态。 */
function extractToolCalls(msg: BaseMessage): NormalizedToolCall[] {
  if (AIMessage.isInstance(msg)) {
    const structured = msg.tool_calls;
    if (Array.isArray(structured) && structured.length > 0) {
      return structured.map((tc: ToolCall) => ({
        id: tc.id,
        name: tc.name ?? 'unknown',
      }));
    }
  }

  const rawList = (msg.additional_kwargs?.tool_calls ?? []) as RawToolCallPayload[];
  if (!Array.isArray(rawList) || rawList.length === 0) return [];

  const out: NormalizedToolCall[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const name = raw.name ?? raw.function?.name ?? 'unknown';
    out.push({ id: raw.id, name });
  }
  return out;
}

export const danglingToolCallRule: IntegrityRule = {
  name: 'DanglingToolCallRule',

  sanitizeHistory(messages) {
    // 收集所有已存在的 tool_call_id
    const existingIds = new Set<string>();
    for (const msg of messages) {
      if (msg instanceof ToolMessage && msg.tool_call_id) {
        existingIds.add(msg.tool_call_id);
      }
    }

    // 第一遍：探测是否需要修补，避免无谓复制
    let needsPatch = false;
    outer: for (const msg of messages) {
      if (!AIMessage.isInstance(msg)) continue;
      for (const tc of extractToolCalls(msg)) {
        if (tc.id && !existingIds.has(tc.id)) {
          needsPatch = true;
          break outer;
        }
      }
    }
    if (!needsPatch) return null;

    // 第二遍：构造新数组，紧跟 AIMessage 后插入占位
    const patched: BaseMessage[] = [];
    const patchedIds = new Set<string>();
    let patchCount = 0;

    for (const msg of messages) {
      patched.push(msg);
      if (!AIMessage.isInstance(msg)) continue;

      for (const tc of extractToolCalls(msg)) {
        const id = tc.id;
        if (!id || existingIds.has(id) || patchedIds.has(id)) continue;
        patched.push(
          new ToolMessage({
            content: '[Tool call was interrupted and did not return a result.]',
            tool_call_id: id,
            name: tc.name,
            status: 'error',
          }),
        );
        patchedIds.add(id);
        patchCount += 1;
      }
    }

    if (patchCount > 0) {
      console.warn(
        `[ToolCallIntegrity/Dangling] Injected ${patchCount} placeholder ToolMessage(s)`,
      );
    }
    return patched;
  },
};
