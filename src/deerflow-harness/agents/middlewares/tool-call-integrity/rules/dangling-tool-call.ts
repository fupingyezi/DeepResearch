import { AIMessage, BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import type { IntegrityRule } from '../types';

/**
 * DanglingToolCallRule
 *
 * 修复消息历史中"悬挂 tool_call"，确保 OpenAI / 兼容 OpenAI 的供应商不会
 * 因消息格式不完整返回 400：
 *   "An assistant message with 'tool_calls' must be followed by tool
 *    messages responding to each 'tool_call_id'."
 *
 * 严格契约（OpenAI 强校验，本规则统一负责修复）：
 *   1) 每一个 assistant.tool_calls[i].id 都必须有匹配的 tool message。
 *   2) tool message 必须**紧邻**该 assistant message 之后；不能被
 *      HumanMessage / SystemMessage / 另一条 AIMessage 分隔。
 *   3) tool_call_id 不重复匹配（一对一）。
 *
 * ## 触发场景
 * - 用户中断 / 断流：tool_call 已生成但 ToolMessage 还没写入即崩。
 * - 子流程异常：subagent 调用 task 后又让父 thread 续跑，但父 history
 *   里 task 的 ToolMessage 没回写到 checkpoint。
 * - 多轮对话夹断：上一轮 assistant 留了 tool_call，下一轮用户直接发
 *   HumanMessage 回来，导致中间夹了非 tool message。
 *
 * ## 修复策略（一遍流式重排）
 * - 遍历 messages：
 *   a) 普通消息：直接 push 进结果。
 *   b) 遇到带 tool_calls 的 AIMessage：先 push 自己，然后**主动消费**后续
 *      所有 ToolMessage（找到匹配的 tool_call_id 就把它放到这条 AI 的
 *      tool_calls 后面），未匹配到的 tool_call_id 用 status='error' 占位
 *      ToolMessage 补齐。
 *   c) "孤立的" ToolMessage（其 tool_call_id 在已处理的 AIMessage 列表
 *      里找不到、且不匹配前置 AIMessage）将被丢弃 —— 它们对模型而言
 *      是噪声。
 *
 * 这样产出的消息列表满足 OpenAI 强校验：每个 assistant.tool_calls 紧跟
 * 完整、无重复、按顺序排列的 tool_result 序列。
 *
 * 与 UnknownToolCallRule 的协作：
 *   先在上游剔除 tool_calls 数组中指向未知工具的项；本规则只负责"剩下
 *   的 tool_calls 必须紧邻、必须配对"，互不重叠。
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

const PLACEHOLDER_CONTENT = '[Tool call was interrupted and did not return a result.]';

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
    if (!Array.isArray(messages) || messages.length === 0) return null;

    // ── 第一遍：探测是否需要修补 ──
    // 三种触发条件之一即需重排：
    //  (a) AIMessage 有 tool_call_id，但后续找不到匹配 ToolMessage；
    //  (b) ToolMessage 紧邻位置错误（前一条不是预期的 AIMessage / 不是它的 tool 后续）；
    //  (c) 存在 tool_call_id 集合外的孤立 ToolMessage。
    // 为简化与稳妥起见，只要存在 (a) 或 (c) 即触发；(b) 由重排自然修复。
    const allToolCallIds = new Set<string>();
    for (const m of messages) {
      if (!AIMessage.isInstance(m)) continue;
      for (const tc of extractToolCalls(m)) {
        if (tc.id) allToolCallIds.add(tc.id);
      }
    }

    let toolMsgCount = 0;
    let orphanToolMsg = false;
    let missingToolResult = false;

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (ToolMessage.isInstance(m)) {
        toolMsgCount += 1;
        const id = m.tool_call_id;
        if (!id || !allToolCallIds.has(id)) {
          orphanToolMsg = true;
        }
      }
    }

    if (!orphanToolMsg) {
      // 检查 (a)：每条 AIMessage 的 tool_call_id 是否都能在后续紧邻位置找到匹配
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (!AIMessage.isInstance(m)) continue;
        const calls = extractToolCalls(m).filter((tc) => !!tc.id);
        if (calls.length === 0) continue;

        const expectedIds = new Set(calls.map((c) => c.id!));
        const matched = new Set<string>();
        let j = i + 1;
        while (j < messages.length && ToolMessage.isInstance(messages[j])) {
          const tm = messages[j] as ToolMessage;
          if (tm.tool_call_id && expectedIds.has(tm.tool_call_id)) {
            matched.add(tm.tool_call_id);
          }
          j += 1;
        }
        if (matched.size !== expectedIds.size) {
          missingToolResult = true;
          break;
        }
      }
    }

    if (!orphanToolMsg && !missingToolResult && toolMsgCount === 0) return null;
    if (!orphanToolMsg && !missingToolResult) return null;

    // ── 第二遍：流式重排 ──
    // 先用一张表把所有 ToolMessage 按 tool_call_id 收集起来（同一个 id
    // 通常只对应一条；如有多条只保留首条，其余视为冗余丢弃）。
    const toolByCallId = new Map<string, ToolMessage>();
    for (const m of messages) {
      if (ToolMessage.isInstance(m) && m.tool_call_id && !toolByCallId.has(m.tool_call_id)) {
        toolByCallId.set(m.tool_call_id, m);
      }
    }

    const patched: BaseMessage[] = [];
    let injectedCount = 0;
    let droppedOrphan = 0;

    for (const m of messages) {
      // ToolMessage：在 AIMessage 处会被消费；这里跳过
      if (ToolMessage.isInstance(m)) {
        if (m.tool_call_id && allToolCallIds.has(m.tool_call_id)) {
          // 已被或将被对应的 AIMessage 消费，不再单独 push
          continue;
        }
        // 完全孤立的 ToolMessage：丢弃
        droppedOrphan += 1;
        continue;
      }

      patched.push(m);

      if (!AIMessage.isInstance(m)) continue;
      const calls = extractToolCalls(m).filter((tc) => !!tc.id);
      if (calls.length === 0) continue;

      // 紧跟 AI 后按 tool_calls 顺序拼接对应 ToolMessage（缺失则补占位）
      for (const tc of calls) {
        const id = tc.id!;
        const existing = toolByCallId.get(id);
        if (existing) {
          patched.push(existing);
          // 标记已消费：避免一条 ToolMessage 被多条同 id 的 AIMessage 重复使用
          toolByCallId.delete(id);
        } else {
          patched.push(
            new ToolMessage({
              content: PLACEHOLDER_CONTENT,
              tool_call_id: id,
              name: tc.name,
              status: 'error',
            }),
          );
          injectedCount += 1;
        }
      }
    }

    if (injectedCount > 0 || droppedOrphan > 0) {
      console.warn(
        `[ToolCallIntegrity/Dangling] Reordered messages ` +
          `(injected=${injectedCount}, droppedOrphan=${droppedOrphan})`,
      );
    }

    return patched;
  },
};
