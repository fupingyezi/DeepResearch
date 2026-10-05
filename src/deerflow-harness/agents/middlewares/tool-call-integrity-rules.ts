import { AIMessage, BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import type { IntegrityRule, RuleContext } from './tool-call-integrity-types';

/**
 * UnknownToolCallRule
 *
 * 目标：消除 LangGraph 的 `Tool "<name>" not found` 异常。
 *
 * ## 触发场景
 *
 * 1) 跨轮工具集变更：同一 thread 下，PostgreSQL checkpointer 持久化的历史
 *    里仍有 `tool_calls: [{ name: 'task', ... }]`，但当前轮没有绑定该工具。
 *    模型据此续写时 ToolNode 在工具映射里找不到，整条 stream 被收敛为
 *    AGENT_STREAM_ERROR。
 *
 * 2) 历史诱导：即便清掉了悬挂 tool_call，模型读到上下文里"上次 call 过
 *    task"仍可能再次输出 `task` 调用。
 *
 * 3) Provider 漂移：少数中转 provider 在 raw payload 里带未知工具名。
 *
 * ## 修复策略（双阶段）
 *
 * - sanitizeHistory：剔除 AIMessage 上指向未知工具的 tool_call，并在该
 *   AIMessage 紧后插入 status='error' 的占位 ToolMessage；同时丢弃因此
 *   变成孤立的旧 ToolMessage（其 tool_call_id 已被剔除）。
 * - sanitizeOutput：在模型刚返回的 AIMessage 上做同样剔除。这一步至关
 *   重要——它阻止 ToolNode 派发到不存在的工具，从根上杜绝 "Tool not found"。
 *
 * ## 安全保障
 *
 * `knownToolNames.size === 0` 时跳过所有清洗。这种情况通常意味着 request
 * 没把 tools 注入进来（极少发生），保守跳过避免误删。
 */

interface RawToolCall {
  id?: string;
  name?: string;
  function?: { name?: string };
}

const PLACEHOLDER_CONTENT = '[Tool call removed: this tool is not registered in the current run.]';

function getToolCallName(tc: any): string {
  const n = tc?.name;
  return typeof n === 'string' ? n : '';
}

function getRawToolCallName(raw: any): string {
  const n = raw?.name ?? raw?.function?.name;
  return typeof n === 'string' ? n : '';
}

/**
 * 直接 mutate AIMessage：剔除 tool_calls / additional_kwargs.tool_calls
 * 中引用未知工具的项，返回被删除项的 (id, name) 列表。
 *
 * 直接 mutate 的合法性：与 qwenToolCallRecoveryMiddleware 同样的做法，
 * AIMessage 在中间件链里是可变对象，传给底层 model.invoke / 进入
 * ToolNode 的就是这一份对象。checkpoint 持久化用的是 reducer 输出，
 * 此处 mutate 不会回写到 checkpoint state。
 */
function sanitizeAiMessage(
  msg: AIMessage,
  known: ReadonlySet<string>,
): Array<{ id: string; name: string }> {
  const removed: Array<{ id: string; name: string }> = [];

  const structured = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  if (structured.length > 0) {
    const kept: ToolCall[] = [];
    for (const tc of structured) {
      const name = getToolCallName(tc);
      if (name && known.has(name)) {
        kept.push(tc);
      } else if (typeof tc?.id === 'string' && tc.id) {
        removed.push({ id: tc.id, name: name || 'unknown_tool' });
      }
    }
    if (kept.length !== structured.length) msg.tool_calls = kept;
  }

  const rawList = (msg.additional_kwargs?.tool_calls ?? []) as RawToolCall[];
  if (Array.isArray(rawList) && rawList.length > 0) {
    const keptRaw = rawList.filter((raw) => {
      const name = getRawToolCallName(raw);
      return !!name && known.has(name);
    });
    if (keptRaw.length !== rawList.length && msg.additional_kwargs) {
      // LangChain 类型升级后 additional_kwargs.tool_calls 要求 OpenAIToolCall（含 type 字段）；
      // keptRaw 是对原始数组的过滤结果，运行时形态与原值一致，按第三方对象边界单层断言。
      msg.additional_kwargs.tool_calls = keptRaw as typeof msg.additional_kwargs.tool_calls;
    }
  }

  return removed;
}

export const unknownToolCallRule: IntegrityRule = {
  name: 'UnknownToolCallRule',

  sanitizeHistory(messages: BaseMessage[], ctx: RuleContext) {
    const known = ctx.knownToolNames;
    if (known.size === 0) return null;

    // 第一遍：探测是否真的有未知 tool_call，避免无谓复制
    let hasUnknown = false;
    for (const m of messages) {
      if (!AIMessage.isInstance(m)) continue;
      const arr = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      for (const tc of arr) {
        const name = getToolCallName(tc);
        if (!name || !known.has(name)) {
          hasUnknown = true;
          break;
        }
      }
      if (hasUnknown) break;

      const rawArr = (m.additional_kwargs?.tool_calls ?? []) as RawToolCall[];
      for (const raw of rawArr) {
        const name = getRawToolCallName(raw);
        if (!name || !known.has(name)) {
          hasUnknown = true;
          break;
        }
      }
      if (hasUnknown) break;
    }
    if (!hasUnknown) return null;

    // 第二遍：构造新数组（mutate AIMessage + 丢弃孤立 ToolMessage + 插占位）
    const result: BaseMessage[] = [];
    const removedIds = new Set<string>();
    let totalRemoved = 0;

    for (const m of messages) {
      if (!AIMessage.isInstance(m)) {
        if (ToolMessage.isInstance(m) && m.tool_call_id && removedIds.has(m.tool_call_id)) {
          continue; // 孤立 ToolMessage：丢弃
        }
        result.push(m);
        continue;
      }

      const removed = sanitizeAiMessage(m, known);
      result.push(m);

      for (const r of removed) {
        removedIds.add(r.id);
        totalRemoved += 1;
        result.push(
          new ToolMessage({
            content: PLACEHOLDER_CONTENT,
            tool_call_id: r.id,
            name: r.name,
            status: 'error',
          }),
        );
      }
    }

    if (totalRemoved > 0) {
      console.warn(
        `[ToolCallIntegrity/Unknown] Stripped ${totalRemoved} tool_call(s) ` +
          `referencing tools outside the current registry`,
      );
    }
    return result;
  },

  sanitizeOutput(message, ctx) {
    if (ctx.knownToolNames.size === 0) return;
    const removed = sanitizeAiMessage(message, ctx.knownToolNames);
    if (removed.length > 0) {
      console.warn(
        `[ToolCallIntegrity/Unknown] Model emitted ${removed.length} tool_call(s) ` +
          `to unknown tools (${removed.map((r) => r.name).join(', ')}); stripped before dispatch`,
      );
    }
  },
};

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

const DANGLING_PLACEHOLDER_CONTENT = '[Tool call was interrupted and did not return a result.]';

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
              content: DANGLING_PLACEHOLDER_CONTENT,
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

/**
 * 默认规则集合（顺序敏感）。
 *
 * 顺序约束：
 *  1) UnknownToolCallRule —— 先剔除指向未知工具的 tool_call 并补占位
 *  2) DanglingToolCallRule —— 再为剩余真正悬挂的 tool_call 补占位
 *
 * 为什么 Unknown 先于 Dangling？
 *   若反过来，Dangling 会先为"未知工具的 tool_call_id"补一条占位 ToolMessage，
 *   然后 Unknown 再剔除该 tool_call、把刚补的占位当作孤立 ToolMessage 丢弃 ——
 *   产生一次无效写入。当前顺序两条规则职责不重叠、各自只做一次工作。
 *
 * 新增规则只需在此处追加导出，外部使用方不感知。
 */
export const DEFAULT_INTEGRITY_RULES: readonly IntegrityRule[] = [
  unknownToolCallRule,
  danglingToolCallRule,
];
