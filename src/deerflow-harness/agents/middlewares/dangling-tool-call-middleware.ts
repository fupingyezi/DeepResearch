import { createMiddleware } from 'langchain';
import {
  AIMessage,
  BaseMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';

/**
 * DanglingToolCallMiddleware（位序 3 / 始终启用）
 *
 * 修复消息历史中"悬挂 tool_call"的问题：
 *
 * 当一条 `AIMessage` 包含 `tool_calls`，但历史中没有相应的 `ToolMessage`
 * （常见于用户中断、请求取消、流断开等），下一次模型调用会因为消息格式
 * 不完整而报错。本中间件在模型调用前扫描历史，对每个缺失的 `tool_call_id`
 * 紧跟在产生它的 `AIMessage` 之后插入一条带 error 状态的占位 `ToolMessage`。
 *
 * 关键设计点：
 * 1. 使用 `wrapModelCall` 而非 `beforeModel`：后者借由 `add_messages` reducer
 *    只能在历史末尾追加，导致占位消息与产生它的 `AIMessage` 之间被其他消息
 *    隔开，违反 OpenAI/Anthropic 等供应商对"tool_call 必须紧邻 tool_result"
 *    的格式要求。`wrapModelCall` 直接重写传给底层模型的 messages，可在精确
 *    位置插入。
 * 2. 兼容两类 tool_call 来源：
 *    - 标准化字段 `message.tool_calls`（LangChain 已规范化）
 *    - 原始供应商载荷 `message.additional_kwargs.tool_calls`
 *      （部分中转/旧 provider 走 OpenAI 的 raw 结构）
 *      其中 `function.arguments` 是字符串，需 JSON.parse 兜底。
 * 3. 仅在确实存在悬挂调用时才返回新 messages，避免不必要的浅拷贝。
 */

interface NormalizedToolCall {
  id?: string;
  name: string;
  args: Record<string, any>;
}

interface RawToolCallPayload {
  id?: string;
  name?: string;
  args?: any;
  function?: {
    name?: string;
    arguments?: any;
  };
}

/** 从结构化字段或原始供应商载荷中提取规范化的 tool_calls */
function extractToolCalls(msg: BaseMessage): NormalizedToolCall[] {
  // 1) 优先使用 LangChain 规范化字段（仅 AIMessage 有）
  if (AIMessage.isInstance(msg)) {
    const structured = msg.tool_calls;
    if (Array.isArray(structured) && structured.length > 0) {
      return structured.map((tc: ToolCall) => ({
        id: tc.id,
        name: tc.name ?? 'unknown',
        args: (tc.args ?? {}) as Record<string, any>,
      }));
    }
  }

  // 2) 回退到原始 additional_kwargs.tool_calls（OpenAI raw 形态）
  const rawList = (msg.additional_kwargs?.tool_calls ?? []) as RawToolCallPayload[];
  if (!Array.isArray(rawList) || rawList.length === 0) {
    return [];
  }

  const normalized: NormalizedToolCall[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;

    const fn = raw.function;
    const name = raw.name ?? fn?.name ?? 'unknown';

    let args: Record<string, any> = {};
    if (raw.args && typeof raw.args === 'object') {
      args = raw.args as Record<string, any>;
    } else if (typeof fn?.arguments === 'string') {
      try {
        const parsed = JSON.parse(fn.arguments);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, any>;
        }
      } catch {
        // 解析失败保持空对象；上游模型一般容忍空 args 的占位回包
        args = {};
      }
    }

    normalized.push({ id: raw.id, name, args });
  }
  return normalized;
}

/**
 * 扫描历史，对悬挂 tool_call 在原 AIMessage 之后插入占位 ToolMessage。
 * 若不需要修补则返回 null，避免无谓的数组复制。
 */
function buildPatchedMessages(messages: BaseMessage[]): BaseMessage[] | null {
  // 收集所有已存在的 ToolMessage.tool_call_id
  const existingIds = new Set<string>();
  for (const msg of messages) {
    if (msg instanceof ToolMessage && msg.tool_call_id) {
      existingIds.add(msg.tool_call_id);
    }
  }

  // 先轻量判定是否需要修补，避免无谓复制
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

  // 构造新列表，紧跟在每条悬挂 AIMessage 之后插入占位
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
      `[DanglingToolCallMiddleware] Injected ${patchCount} placeholder ToolMessage(s) for dangling tool calls`,
    );
  }
  return patched;
}

export const danglingToolCallMiddleware = createMiddleware({
  name: 'DanglingToolCallMiddleware',
  wrapModelCall: async (request, handler) => {
    const patched = buildPatchedMessages(request.messages);
    if (patched) {
      return handler({ ...request, messages: patched });
    }
    return handler(request);
  },
});
