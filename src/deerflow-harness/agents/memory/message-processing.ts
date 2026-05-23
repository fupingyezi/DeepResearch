/**
 * Message processing。
 *
 * - filterMessagesForMemory：只保留 user 输入与最终 assistant 回复（剔除工具调用/工具结果）。
 * - detectCorrection / detectReinforcement：识别 user 显式纠正 / 强化反馈。
 *
 * Message 类型对齐 LangChain.js（HumanMessage / AIMessage / ToolMessage 都有 `_getType()`）。
 */

import { BaseMessage } from '@langchain/core/messages';

const UPLOAD_BLOCK_RE = /<uploaded_files>[\s\S]*?<\/uploaded_files>\n*/gi;

const CORRECTION_PATTERNS: RegExp[] = [
  /\bthat(?:'s| is) (?:wrong|incorrect)\b/i,
  /\byou misunderstood\b/i,
  /\btry again\b/i,
  /\bredo\b/i,
  /不对/,
  /你理解错了/,
  /你理解有误/,
  /重试/,
  /重新来/,
  /换一种/,
  /改用/,
];

const REINFORCEMENT_PATTERNS: RegExp[] = [
  /\byes[,.]?\s+(?:exactly|perfect|that(?:'s| is) (?:right|correct|it))\b/i,
  /\bperfect(?:[.!?]|$)/i,
  /\bexactly\s+(?:right|correct)\b/i,
  /\bthat(?:'s| is)\s+(?:exactly\s+)?(?:right|correct|what i (?:wanted|needed|meant))\b/i,
  /\bkeep\s+(?:doing\s+)?that\b/i,
  /\bjust\s+(?:like\s+)?(?:that|this)\b/i,
  /\bthis is (?:great|helpful)\b(?:[.!?]|$)/i,
  /\bthis is what i wanted\b(?:[.!?]|$)/i,
  /对[，,]?\s*就是这样(?:[。！？!?.]|$)/,
  /完全正确(?:[。！？!?.]|$)/,
  /(?:对[，,]?\s*)?就是这个意思(?:[。！？!?.]|$)/,
  /正是我想要的(?:[。！？!?.]|$)/,
  /继续保持(?:[。！？!?.]|$)/,
];

/** 把 LangChain Message 的 content 抽成纯文本（兼容多模态 list-of-blocks）。 */
export function extractMessageText(message: any): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (block && typeof block === 'object' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    return parts.join(' ');
  }
  return content == null ? '' : String(content);
}

function getMessageType(msg: any): string | undefined {
  if (typeof msg?._getType === 'function') {
    return msg._getType();
  }
  // 兜底：少数 mock 对象用 type 字段
  return typeof msg?.type === 'string' ? msg.type : undefined;
}

function hasToolCalls(msg: any): boolean {
  const tc = msg?.tool_calls;
  return Array.isArray(tc) && tc.length > 0;
}

/**
 * 只保留 user 输入与最终 assistant 回复（无 tool_calls 的 AI message）。
 * - human message 中 `<uploaded_files>...</uploaded_files>` 被剥离；
 *   若剥离后内容为空，下一条 AI 回复也跳过（属于 upload-only turn）。
 */
export function filterMessagesForMemory(messages: BaseMessage[] | any[]): BaseMessage[] {
  const filtered: any[] = [];
  let skipNextAi = false;

  for (const msg of messages) {
    const t = getMessageType(msg);
    if (t === 'human') {
      const text = extractMessageText(msg);
      if (text.includes('<uploaded_files>')) {
        const stripped = text.replace(UPLOAD_BLOCK_RE, '').trim();
        if (!stripped) {
          skipNextAi = true;
          continue;
        }
        // 浅拷贝并替换 content
        const cleaned = shallowCloneMessage(msg);
        cleaned.content = stripped;
        filtered.push(cleaned);
        skipNextAi = false;
      } else {
        filtered.push(msg);
        skipNextAi = false;
      }
    } else if (t === 'ai') {
      if (hasToolCalls(msg)) continue;
      if (skipNextAi) {
        skipNextAi = false;
        continue;
      }
      filtered.push(msg);
    }
    // tool / system / 其它一律忽略
  }

  return filtered as BaseMessage[];
}

function shallowCloneMessage(msg: any): any {
  // 优先用 LangChain 内置克隆（同类构造），失败则简单展开。
  try {
    const Ctor = msg?.constructor;
    if (typeof Ctor === 'function') {
      const cloned = new Ctor({
        content: msg.content,
        additional_kwargs: msg.additional_kwargs ?? {},
        response_metadata: msg.response_metadata ?? {},
        name: msg.name,
        id: msg.id,
      });
      return cloned;
    }
  } catch {
    // fall through
  }
  return { ...msg };
}

export function detectCorrection(messages: BaseMessage[] | any[]): boolean {
  const recentUser = sliceRecentUser(messages, 6);
  for (const msg of recentUser) {
    const text = extractMessageText(msg).trim();
    if (text && CORRECTION_PATTERNS.some((re) => re.test(text))) return true;
  }
  return false;
}

export function detectReinforcement(messages: BaseMessage[] | any[]): boolean {
  const recentUser = sliceRecentUser(messages, 6);
  for (const msg of recentUser) {
    const text = extractMessageText(msg).trim();
    if (text && REINFORCEMENT_PATTERNS.some((re) => re.test(text))) return true;
  }
  return false;
}

function sliceRecentUser(messages: any[], k: number): any[] {
  const tail = messages.slice(-k);
  return tail.filter((m) => getMessageType(m) === 'human');
}

/** 至少包含一条 user 与一条 assistant 才算"有意义对话"。 */
export function hasUserAndAi(messages: BaseMessage[] | any[]): boolean {
  let hasUser = false;
  let hasAi = false;
  for (const m of messages) {
    const t = getMessageType(m);
    if (t === 'human') hasUser = true;
    else if (t === 'ai') hasAi = true;
    if (hasUser && hasAi) return true;
  }
  return false;
}
