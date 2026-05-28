import {
  AIMessage,
  BaseMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import type { IntegrityRule, RuleContext } from '../types';

/**
 * UnknownToolCallRule
 *
 * 目标：消除 LangGraph 的 `Tool "<name>" not found` 异常。
 *
 * ## 触发场景
 *
 * 1) 跨轮工具集变更：同一 thread 下，前一轮 `subagent_enabled=true` 注入了
 *    `task` 工具，下一轮切回普通 chat（`subagent_enabled=false`）后 `task`
 *    不再绑定。但 PostgreSQL checkpointer 持久化的历史里仍有
 *    `tool_calls: [{ name: 'task', ... }]`，模型据此续写时 ToolNode 在
 *    工具映射里找不到，整条 stream 被收敛为 AGENT_STREAM_ERROR。
 *
 * 2) 历史诱导：即便清掉了悬挂 tool_call，模型读到上下文里"上次 call 过
 *    task"仍可能再次输出 `task` 调用。
 *
 * 3) Provider 漂移：少数中转/旧 provider 在 raw payload 里带未知工具名。
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

const PLACEHOLDER_CONTENT =
  '[Tool call removed: this tool is not registered in the current run.]';

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
      msg.additional_kwargs.tool_calls = keptRaw;
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
        if (
          m instanceof ToolMessage &&
          m.tool_call_id &&
          removedIds.has(m.tool_call_id)
        ) {
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
