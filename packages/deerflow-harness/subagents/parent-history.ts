/**
 * parent-history —— 子 agent 只读读取父线程历史（上下文注入）
 *
 * 子 agent 是独立 top-level 流（见 executor.ts 的 buildSubagentStreamConfig 注释），
 * 输入里只有 lead 写的任务 prompt，看不到父线程的多轮上下文。本模块提供「父历史
 * 只读读取」注入点：
 *
 * - app 层（wiring.ts）经 setParentHistoryProvider 注入基于 checkpointer 的
 *   getTuple 读取（checkpointer 在 app 层创建，harness 不持有，模式对齐
 *   setThreadImageFetcher）；
 * - SubagentExecutor 在构造子 agent 输入前读一次，剪枝为纯文本上下文块，
 *   作为 SystemMessage 前置（背景上下文，不污染任务语义）。
 *
 * 与「子图状态不落 checkpoint」的决定正交：这里只读父线程 checkpoint，
 * 不写任何状态、不动 buildSubagentStreamConfig。
 */

import { extractMessageContentText } from '@/utils/common';

/**
 * 由 app 层注册（checkpointer.getTuple 实现）；未注册时子 agent 不带父历史运行。
 * 返回父线程 checkpoint 的原始 messages（剪枝在 harness 侧完成，便于单测）。
 */
export type ParentHistoryProvider = (threadId: string) => Promise<unknown[] | undefined>;

let _provider: ParentHistoryProvider | null = null;

export function setParentHistoryProvider(provider: ParentHistoryProvider | null): void {
  _provider = provider;
}

export function getParentHistoryProvider(): ParentHistoryProvider | null {
  return _provider;
}

/** 上下文块总字符预算：注入内容随每次 task 调用重复计费 token，必须封顶。 */
export const PARENT_CONTEXT_MAX_CHARS = 4000;
/** 单条消息字符上限（工具结果尤长，如搜索结果），超出从头截断。 */
export const PARENT_CONTEXT_PER_MESSAGE_CHARS = 1000;
/** 最多回看条数（预算之外的硬上限，防超长线程拖慢读取）。 */
const PARENT_CONTEXT_MAX_MESSAGES = 20;

const TRUNCATION_MARK = '…[截断]';
/** uploads 块带入文件名与解析正文，进上下文只会稀释有效信息（与 client.ts 同款）。 */
const UPLOAD_BLOCK_RE = /<uploaded_files>[\s\S]*?<\/uploaded_files>\n*/gi;

interface RawMessageLike {
  _getType?: () => string;
  type?: unknown;
  name?: unknown;
  content?: unknown;
}

/**
 * 把父线程消息剪枝为纯文本上下文块（纯函数，便于单测）：
 * - 只取文本（extractMessageContentText 忽略 image_url 等非文本块，base64 不进 prompt）
 * - 剥离 uploads 注入块
 * - 跳过 system 消息（子 agent 有自己的 systemPrompt）与纯 tool_call 的 AI 消息
 *   （无信息量；末尾那条就是 task 调用本身，与任务 prompt 重复）
 * - 从最近往回挑（时间序输出旧→新），预算/条数耗尽即停
 */
export function buildParentContextBlock(messages: unknown[]): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  const lines: string[] = [];
  let total = 0;

  for (let i = messages.length - 1; i >= 0 && lines.length < PARENT_CONTEXT_MAX_MESSAGES; i--) {
    const raw = messages[i] as RawMessageLike;
    const role = typeof raw?._getType === 'function' ? raw._getType() : raw?.type;

    if (role !== 'human' && role !== 'ai' && role !== 'tool') continue;

    const text = extractMessageContentText(raw?.content).replace(UPLOAD_BLOCK_RE, '').trim();
    if (!text) continue;

    const label = role === 'human' ? '[user]' : role === 'tool' ? '[tool result]' : '[assistant]';
    const toolName = role === 'tool' && typeof raw?.name === 'string' ? raw.name.trim() : '';
    const line = `${
      role === 'tool' && toolName ? `[tool result: ${toolName}]` : label
    }\n${text.length > PARENT_CONTEXT_PER_MESSAGE_CHARS ? text.slice(0, PARENT_CONTEXT_PER_MESSAGE_CHARS) + TRUNCATION_MARK : text}`;

    if (total + line.length > PARENT_CONTEXT_MAX_CHARS) break; // 预算耗尽，更早的历史让位
    total += line.length;
    lines.unshift(line);
  }

  if (lines.length === 0) return '';
  return `[parent conversation context]\n${lines.join('\n\n')}`;
}

/** 读父历史失败的告警（只报一次，避免每次 task 调用刷屏）。 */
let warnedParentHistoryFailure = false;

/**
 * 读取并剪枝父线程历史；任何一步失败（provider 未注册 / 读取异常 / 无可注入内容）
 * 一律静默回落 undefined —— 上下文注入是增强，不应阻断 task 执行。
 */
export async function readParentHistoryBlock(threadId: string): Promise<string | undefined> {
  const provider = getParentHistoryProvider();
  if (!provider) return undefined;
  try {
    const messages = await provider(threadId);
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    return buildParentContextBlock(messages) || undefined;
  } catch (e) {
    if (!warnedParentHistoryFailure) {
      warnedParentHistoryFailure = true;
      console.warn(
        '[subagents/parent-history] read failed, subagent runs without parent context:',
        e,
      );
    }
    return undefined;
  }
}
