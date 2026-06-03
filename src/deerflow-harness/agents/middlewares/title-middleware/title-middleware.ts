import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createMiddleware } from 'langchain';

import { query } from '@/lib/db';
import { getContext } from '../../../runtime/context';
import { publishTitleUpdate } from './title-bus';

/**
 * TitleMiddleware（features.autoTitle 启用）
 *
 * 职责：
 * - 在 `afterAgent`（一轮交互末尾）根据用户首条消息生成会话标题，写入
 *   `ThreadState.title` 并同步落库到 `chat_session.title` / `threads_meta.display_name`
 *
 * 触发条件（全部满足才生成）：
 *   1. `getContext().thread_id` 或 `runtime.configurable.thread_id` 存在；
 *   2. `state.messages` 至少 1 条 user + 1 条 assistant（首轮已结束）；
 *   3. `state.title` 为空；
 *   4. DB 当前 title / display_name **任一**为占位（`New thread` 或等于首条
 *      user 文本前 15 字截断）。
 *
 * LLM 模型：
 * - 通过 `setTitleModelFactory` 注入（同 memory 子系统模式）。上层（_service.ts）
 *   调用一次 `setTitleModelFactory(modelName => createChatModel(buildModelConfigFromPreset(...)))`，
 * - `TITLE_MODEL` env 用作"模型名 hint"传给 factory（factory 自行决定如何映射，
 *   通常是 preset key 或 modelName）；缺省时 factory 走默认 preset。
 *
 * 错误隔离：整段 try/catch，任何异常仅 `console.error`，不影响主流程。
 */

const PLACEHOLDER_TITLE = 'New thread';
const PLACEHOLDER_USER_SNIPPET_LENGTH = 15;
const TITLE_MAX_CHARS = 30;
const USER_INPUT_TRUNCATE = 500;

interface TitleConfigRow {
  title: string | null;
  display_name: string | null;
}

// ── Title model factory injection（与 memory 子系统同模式） ───────────────────
export type TitleModelFactory = (modelName: string | null | undefined) => BaseChatModel;

let _titleModelFactory: TitleModelFactory | null = null;

export function setTitleModelFactory(factory: TitleModelFactory | null): void {
  _titleModelFactory = factory;
}

export function getTitleModelFactory(): TitleModelFactory | null {
  return _titleModelFactory;
}

let warnedNoFactory = false;
let titleModelInstance: BaseChatModel | null = null;

/**
 * lazy 单例：title 生成模型独立于 agent 主模型，整个进程共享一份连接。
 * - factory 未注册：返回 null（首次 warn 一次），调用方据此跳过 LLM 调用。
 * - factory 已注册：用 `process.env.TITLE_MODEL` 作为 hint 传给 factory。
 */
function getTitleModel(): BaseChatModel | null {
  if (titleModelInstance) return titleModelInstance;
  const factory = _titleModelFactory;
  if (!factory) {
    if (!warnedNoFactory) {
      console.warn(
        '[titleMiddleware] no TitleModelFactory registered; title generation disabled. ' +
          'Call setTitleModelFactory() at app bootstrap (see _service.ts).',
      );
      warnedNoFactory = true;
    }
    return null;
  }
  try {
    const modelName = process.env.TITLE_MODEL ?? null;
    titleModelInstance = factory(modelName);
    return titleModelInstance;
  } catch (e) {
    console.error('[titleMiddleware] TitleModelFactory threw:', e);
    return null;
  }
}

export const titleMiddleware = createMiddleware({
  name: 'TitleMiddleware',
  afterAgent: async (state: any, runtime: any) => {
    try {
      const ctx = getContext();
      const threadId =
        ctx?.thread_id ??
        runtime?.configurable?.thread_id ??
        runtime?.config?.configurable?.thread_id;
      if (!threadId) {
        console.log('[titleMiddleware] skip: no thread_id (ALS + runtime both empty)');
        return undefined;
      }

      const messages = (state?.messages ?? []) as BaseMessage[];
      const firstUser = findFirstHumanMessage(messages);
      if (!firstUser) {
        console.log('[titleMiddleware] skip: no HumanMessage');
        return undefined;
      }
      if (!hasAssistantResponse(messages)) {
        console.log(
          '[titleMiddleware] skip: no AIMessage at all; messages summary=',
          summarizeMessages(messages),
        );
        return undefined;
      }

      // state.title 已写过则跳过
      if (typeof state?.title === 'string' && state.title.length > 0) {
        console.log('[titleMiddleware] skip: state.title already set =', state.title);
        return undefined;
      }

      const firstUserText = extractTextContent(firstUser).trim();
      if (firstUserText.length === 0) {
        console.log('[titleMiddleware] skip: empty first user text');
        return undefined;
      }

      const placeholderSnippet = firstUserText.slice(0, PLACEHOLDER_USER_SNIPPET_LENGTH);
      const dbState = await loadCurrentTitle(threadId);
      if (
        !isPlaceholder(dbState?.title, placeholderSnippet) &&
        !isPlaceholder(dbState?.display_name, placeholderSnippet)
      ) {
        console.log(
          '[titleMiddleware] skip: DB title already meaningful',
          'thread=',
          threadId,
          'title=',
          dbState?.title,
          'display_name=',
          dbState?.display_name,
        );
        return undefined;
      }

      const model = getTitleModel();
      if (!model) {
        // getTitleModel 内部已 console.warn 过 apiKey 缺失
        return undefined;
      }

      const generated = await invokeTitleLlm(model, firstUserText);
      const cleanTitle = sanitizeTitle(generated);
      if (cleanTitle.length === 0) {
        console.log('[titleMiddleware] skip: LLM returned empty title, raw=', generated);
        return undefined;
      }

      await persistTitle(threadId, cleanTitle);
      const updatedAt = Date.now();
      // 桥接到 SSE 输出层：END 事件会带上 titleUpdate，前端据此即时刷新 sider。
      publishTitleUpdate(threadId, {
        sessionId: threadId,
        title: cleanTitle,
        updatedAt,
      });
      console.log('[titleMiddleware] persisted title=', cleanTitle, 'thread=', threadId);

      return { title: cleanTitle };
    } catch (e) {
      console.error('[titleMiddleware] afterAgent error:', e);
      return undefined;
    }
  },
});

/**
 * 类型判定：用稳定的 `getType()` 字符串契约
 */
type MessageWithType = BaseMessage & {
  getType?: () => string;
  _getType?: () => string;
};

function getMessageType(m: BaseMessage): string {
  const mAny = m as MessageWithType;
  return mAny.getType?.() ?? mAny._getType?.() ?? '';
}

function findFirstHumanMessage(messages: BaseMessage[]): HumanMessage | null {
  for (const m of messages) {
    if (getMessageType(m) === 'human') return m as HumanMessage;
  }
  return null;
}

function hasAssistantResponse(messages: BaseMessage[]): boolean {
  // 放宽到"存在 AIMessage 即可"：afterAgent 触发本身就强烈意味着一轮 LLM 调用
  // 已经完成；即使这条 AIMessage 仅含 tool_calls / reasoning 而没有 text，
  // 也说明 LLM 已经回应过本轮——生成标题是合理的（标题素材来自 HumanMessage）。
  for (const m of messages) {
    if (getMessageType(m) === 'ai') return true;
  }
  return false;
}

/**
 * 诊断辅助：把 messages 数组浓缩成可读结构，便于排查"为何没找到 AIMessage"。
 * 仅在跳过分支按需调用，正常路径不消耗。
 */
function summarizeMessages(messages: BaseMessage[]): string {
  const summary = messages.map((m, i) => {
    const type = getMessageType(m) || m.constructor?.name || 'unknown';
    const content = m.content;
    let contentInfo: string;
    if (typeof content === 'string') {
      contentInfo = `str(${content.length})`;
    } else if (Array.isArray(content)) {
      const types = content.map((b) =>
        b && typeof b === 'object' ? ((b as { type?: string }).type ?? 'noType') : typeof b,
      );
      contentInfo = `arr[${types.join(',')}]`;
    } else {
      contentInfo = `${typeof content}`;
    }
    return `${i}:${type}(${contentInfo})`;
  });
  return `count=${messages.length} ${summary.join(' ')}`;
}

/**
 * 把 BaseMessage.content 扁平化为字符串：兼容 string 与 list-of-blocks 两种形态。
 *
 * deer-flow `_normalize_content` 的 TS 等价；多模态 image block 跳过，仅取 text。
 */
function extractTextContent(msg: BaseMessage): string {
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as { type?: string; text?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
  }
  return parts.join('\n');
}

function isPlaceholder(value: string | null | undefined, userSnippet: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return true;
  if (value === PLACEHOLDER_TITLE) return true;
  if (userSnippet.length > 0 && value === userSnippet) return true;
  return false;
}

async function loadCurrentTitle(threadId: string): Promise<TitleConfigRow | null> {
  // chat_session 与 threads_meta 都按 id = threadId 主键查询；left join 以兼容
  // 仅在其中一边存在的 race（理论上 v3/chat 路由两边都会创建）。
  const res = await query(
    `select cs.title as title, tm.display_name as display_name
       from threads_meta tm
       left join chat_session cs on cs.id = tm.thread_id
      where tm.thread_id = $1
      limit 1;`,
    [threadId],
  );
  const row = res.rows?.[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    title: row.title == null ? null : String(row.title),
    display_name: row.display_name == null ? null : String(row.display_name),
  };
}

async function invokeTitleLlm(model: BaseChatModel, firstUserText: string): Promise<string> {
  const truncated = firstUserText.slice(0, USER_INPUT_TRUNCATE);
  const sys = new SystemMessage(
    `You generate a concise thread title (≤ ${TITLE_MAX_CHARS} chars) summarizing the user's first message. ` +
      'Reply in the SAME language as the user. ' +
      'Output the title text ONLY, without quotes, punctuation suffix, or any explanation.',
  );
  const human = new HumanMessage(truncated);
  // callbacks: [] 必须显式空数组：阻断 LangGraph 上层 callback manager 在 stream
  // 已结束后被复用，否则会触发 `ERR_INVALID_STATE`（参考 memory 子系统约定）。
  const resp = await model.invoke([sys, human], { callbacks: [] });
  const content = resp.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as { type?: string; text?: unknown };
        if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
    }
    return parts.join('');
  }
  return '';
}

/**
 * 标题清洗：
 * - 去首尾空白与换行；
 * - 剥离常见包裹引号（含中文「『等）；
 * - 去掉 `<think>...</think>` 推理段（兼容推理类模型）；
 * - 截断至 TITLE_MAX_CHARS；
 * - 单行（取首行非空）。
 */
function sanitizeTitle(raw: string): string {
  if (typeof raw !== 'string') return '';
  let s = raw;
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.trim();
  // 取首行（去掉模型多余的解释行）
  const firstLine = s
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return '';
  // 剥离首尾引号
  s = firstLine
    .replace(/^["'「『《]+/, '')
    .replace(/["'」』》]+$/, '')
    .trim();
  // 去尾随标点
  s = s.replace(/[。.！!？?；;,，:：]+$/u, '').trim();
  if (s.length > TITLE_MAX_CHARS) s = s.slice(0, TITLE_MAX_CHARS);
  return s;
}

async function persistTitle(threadId: string, title: string): Promise<void> {
  // 两条独立 query，任一失败仅 console.error，不阻塞另一条。
  // chat_session 是前端 sider 列表数据源；threads_meta 是 deerflow-harness 的
  // 元信息表，未来 deer-flow 风格 worker 收尾或 ownership 校验也会用到。
  try {
    await query(`update chat_session set title = $1, updated_at = now() where id = $2;`, [
      title,
      threadId,
    ]);
  } catch (e) {
    console.error('[titleMiddleware] update chat_session.title failed:', e);
  }
  try {
    await query(
      `update threads_meta set display_name = $1, updated_at = now() where thread_id = $2;`,
      [title, threadId],
    );
  } catch (e) {
    console.error('[titleMiddleware] update threads_meta.display_name failed:', e);
  }
}
