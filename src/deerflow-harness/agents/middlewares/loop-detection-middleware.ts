import { createMiddleware } from 'langchain';
import { createHash } from 'node:crypto';
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
  type MessageContent,
} from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';

/**
 * LoopDetectionMiddleware（位序 12 / 始终启用）
 *
 * 双层检测：
 *  1. **哈希层**：将一组 tool_calls 规范化为稳定 key，命中相同哈希
 *     ≥ warnThreshold 时注入警告，≥ hardLimit 时强制剥离 tool_calls。
 *  2. **频次层**：按工具名累计调用次数（不区分参数），
 *     防止"同一工具+不同参数"刷量（典型如对 40 个文件循环 read_file）。
 *
 * 触发后：
 *  - 警告：注入一条 HumanMessage（避免 Anthropic 多 system 报错）。
 *  - 硬停：重建最后一条 AIMessage，清空 `tool_calls` / `additional_kwargs.tool_calls`
 *    / `additional_kwargs.function_call`，并把 `response_metadata.finish_reason`
 *    从 'tool_calls' 改为 'stop'，把警告附加到 content 末尾。
 *
 * 与 Python 版差异：
 *  - 单线程 JS：无需 `threading.Lock`。
 *  - `OrderedDict` → `Map`（Map 保留插入顺序，`set/delete` 即可实现 LRU）。
 *  - `runtime.context.thread_id` → `runtime.configurable.thread_id`
 *    （TS 端 LangGraph 的 thread_id 在 configurable 而非 context 上）。
 *  - 单一 `afterModel` 异步 hook 同时覆盖 sync/async。
 */

// ───── Defaults ─────────────────────────────────────────────────────────────
const DEFAULT_WARN_THRESHOLD = 3;
const DEFAULT_HARD_LIMIT = 5;
const DEFAULT_WINDOW_SIZE = 20;
const DEFAULT_MAX_TRACKED_THREADS = 100;
const DEFAULT_TOOL_FREQ_WARN = 30;
const DEFAULT_TOOL_FREQ_HARD_LIMIT = 50;

const WARNING_MSG =
  '[LOOP DETECTED] You are repeating the same tool calls. Stop calling tools and produce your final answer now. If you cannot complete the task, summarize what you accomplished so far.';

const HARD_STOP_MSG =
  '[FORCED STOP] Repeated tool calls exceeded the safety limit. Producing final answer with results collected so far.';

const toolFreqWarning = (toolName: string, count: number) =>
  `[LOOP DETECTED] You have called ${toolName} ${count} times without producing a final answer. Stop calling tools and produce your final answer now. If you cannot complete the task, summarize what you accomplished so far.`;

const toolFreqHardStop = (toolName: string, count: number) =>
  `[FORCED STOP] Tool ${toolName} called ${count} times — exceeded the per-tool safety limit. Producing final answer with results collected so far.`;

// ───── Types ────────────────────────────────────────────────────────────────
export interface LoopDetectionOptions {
  warnThreshold?: number;
  hardLimit?: number;
  windowSize?: number;
  maxTrackedThreads?: number;
  toolFreqWarn?: number;
  toolFreqHardLimit?: number;
}

interface ThreadState {
  history: string[];
  warnedHashes: Set<string>;
  toolFreq: Map<string, number>;
  toolFreqWarned: Set<string>;
}

// ───── Helpers ──────────────────────────────────────────────────────────────
/** 稳定 JSON 序列化：按 key 排序，保证 hash 与 fallback key 的确定性。 */
function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return '[Circular]';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      sorted[k] = walk((v as Record<string, unknown>)[k]);
    }
    return sorted;
  };
  try {
    return JSON.stringify(walk(value));
  } catch {
    return String(value);
  }
}

/** 把 tool_call.args 规范化为 dict + 可选 fallback key（JSON 字符串场景）。 */
function normalizeToolCallArgs(raw: unknown): {
  args: Record<string, unknown>;
  fallback: string | null;
} {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { args: raw as Record<string, unknown>, fallback: null };
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { args: parsed as Record<string, unknown>, fallback: null };
      }
      return { args: {}, fallback: stableStringify(parsed) };
    } catch {
      return { args: {}, fallback: raw };
    }
  }
  if (raw == null) return { args: {}, fallback: null };
  return { args: {}, fallback: stableStringify(raw) };
}

/** 从工具名 + 显著字段派生稳定 key（与 Python 版语义对齐）。 */
function stableToolKey(
  name: string,
  args: Record<string, unknown>,
  fallback: string | null,
): string {
  // read_file: 按 200 行为粒度做行号 bucket，降低噪声
  if (name === 'read_file' && fallback === null) {
    const path = (args.path as string | undefined) ?? '';
    const bucketSize = 200;
    const toInt = (v: unknown, def: number) => {
      if (v == null) return def;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? Math.trunc(n) : def;
    };
    let startLine = toInt(args.start_line, 1);
    let endLine = toInt(args.end_line, startLine);
    if (startLine > endLine) [startLine, endLine] = [endLine, startLine];
    const bucketStart = Math.max(0, Math.floor((Math.max(startLine, 1) - 1) / bucketSize));
    const bucketEnd = Math.max(0, Math.floor((Math.max(endLine, 1) - 1) / bucketSize));
    return `${path}:${bucketStart}-${bucketEnd}`;
  }

  // write_file / str_replace 内容敏感：同一路径在迭代中应被视为不同调用
  if (name === 'write_file' || name === 'str_replace') {
    return fallback ?? stableStringify(args);
  }

  // 其余按显著字段子集
  const SALIENT = ['path', 'url', 'query', 'command', 'pattern', 'glob', 'cmd'];
  const stable: Record<string, unknown> = {};
  for (const f of SALIENT) {
    if (args[f] != null) stable[f] = args[f];
  }
  if (Object.keys(stable).length > 0) return stableStringify(stable);
  return fallback ?? stableStringify(args);
}

/** 多 tool_calls 的有序无关哈希（同一多重集 → 同一 hash）。 */
function hashToolCalls(toolCalls: readonly ToolCall[]): string {
  const normalized: string[] = [];
  for (const tc of toolCalls) {
    const name = tc.name ?? '';
    const { args, fallback } = normalizeToolCallArgs(tc.args ?? {});
    normalized.push(`${name}:${stableToolKey(name, args, fallback)}`);
  }
  normalized.sort();
  const blob = stableStringify(normalized);
  return createHash('md5').update(blob).digest('hex').slice(0, 12);
}

/** 把警告文本拼接到 AIMessage.content（兼容 string / content blocks）。 */
function appendText(content: MessageContent | undefined, text: string): MessageContent {
  if (content == null) return text;
  if (typeof content === 'string') return content + `\n\n${text}`;
  if (Array.isArray(content)) {
    // ContentBlock.Text 字面量；通过 const 断言让 TS 把 type 推断为 'text' 字面量类型
    return [...content, { type: 'text' as const, text: `\n\n${text}` }];
  }
  return String(content) + `\n\n${text}`;
}

/** 重建最后一条 AIMessage，剥离 tool_calls 元数据并改写 finish_reason。 */
function buildHardStopMessage(last: AIMessage, finalContent: MessageContent): AIMessage {
  const additionalKwargs = { ...(last.additional_kwargs ?? {}) };
  delete additionalKwargs.tool_calls;
  delete additionalKwargs.function_call;

  const responseMetadata = JSON.parse(JSON.stringify(last.response_metadata ?? {})) as Record<
    string,
    unknown
  >;
  if (responseMetadata.finish_reason === 'tool_calls') {
    responseMetadata.finish_reason = 'stop';
  }

  return new AIMessage({
    id: last.id,
    content: finalContent,
    name: last.name,
    tool_calls: [],
    invalid_tool_calls: last.invalid_tool_calls ?? [],
    usage_metadata: last.usage_metadata,
    additional_kwargs: additionalKwargs,
    response_metadata: responseMetadata,
  });
}

// ───── Per-instance tracker (LRU via Map insertion order) ───────────────────
class LoopTracker {
  private readonly threads = new Map<string, ThreadState>();

  constructor(private readonly maxTracked: number) {}

  /** 获取并 LRU-touch；不存在则创建并按需 evict。 */
  touch(threadId: string): ThreadState {
    const existing = this.threads.get(threadId);
    if (existing) {
      // 重新插入到末尾以更新 LRU 位次
      this.threads.delete(threadId);
      this.threads.set(threadId, existing);
      return existing;
    }
    const fresh: ThreadState = {
      history: [],
      warnedHashes: new Set(),
      toolFreq: new Map(),
      toolFreqWarned: new Set(),
    };
    this.threads.set(threadId, fresh);
    while (this.threads.size > this.maxTracked) {
      const oldest = this.threads.keys().next().value;
      if (oldest === undefined) break;
      this.threads.delete(oldest);
    }
    return fresh;
  }

  reset(threadId?: string): void {
    if (threadId) this.threads.delete(threadId);
    else this.threads.clear();
  }
}

// ───── Factory ──────────────────────────────────────────────────────────────
export function createLoopDetectionMiddleware(options: LoopDetectionOptions = {}) {
  const warnThreshold = options.warnThreshold ?? DEFAULT_WARN_THRESHOLD;
  const hardLimit = options.hardLimit ?? DEFAULT_HARD_LIMIT;
  const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
  const maxTrackedThreads = options.maxTrackedThreads ?? DEFAULT_MAX_TRACKED_THREADS;
  const toolFreqWarn = options.toolFreqWarn ?? DEFAULT_TOOL_FREQ_WARN;
  const toolFreqHardLimit = options.toolFreqHardLimit ?? DEFAULT_TOOL_FREQ_HARD_LIMIT;

  const tracker = new LoopTracker(maxTrackedThreads);

  function getThreadId(runtime: { configurable?: { thread_id?: string } }): string {
    return runtime.configurable?.thread_id || 'default';
  }

  /** 跟踪 + 检测，返回 [warning, hardStop]。 */
  function trackAndCheck(
    state: { messages: BaseMessage[] },
    threadId: string,
  ): [string | null, boolean] {
    const messages = state.messages;
    if (!messages || messages.length === 0) return [null, false];

    const last = messages[messages.length - 1];
    if (!AIMessage.isInstance(last)) return [null, false];
    const toolCalls = last.tool_calls;
    if (!toolCalls || toolCalls.length === 0) return [null, false];

    const callHash = hashToolCalls(toolCalls);
    const ts = tracker.touch(threadId);

    // 滑动窗口
    ts.history.push(callHash);
    if (ts.history.length > windowSize) {
      ts.history.splice(0, ts.history.length - windowSize);
    }
    const count = ts.history.reduce((acc, h) => (h === callHash ? acc + 1 : acc), 0);
    const toolNames = toolCalls.map((tc) => tc.name ?? '?');

    // ── Layer 1: 哈希层
    if (count >= hardLimit) {
      console.error(`[LoopDetectionMiddleware] hard limit reached — forcing stop`, {
        threadId,
        callHash,
        count,
        tools: toolNames,
      });
      return [HARD_STOP_MSG, true];
    }

    if (count >= warnThreshold && !ts.warnedHashes.has(callHash)) {
      ts.warnedHashes.add(callHash);
      console.warn(`[LoopDetectionMiddleware] repetitive tool calls — injecting warning`, {
        threadId,
        callHash,
        count,
        tools: toolNames,
      });
      return [WARNING_MSG, false];
    }

    // ── Layer 2: 频次层
    for (const tc of toolCalls) {
      const name = tc.name ?? '';
      if (!name) continue;
      const next = (ts.toolFreq.get(name) ?? 0) + 1;
      ts.toolFreq.set(name, next);

      if (next >= toolFreqHardLimit) {
        console.error(`[LoopDetectionMiddleware] tool frequency hard limit — forcing stop`, {
          threadId,
          toolName: name,
          count: next,
        });
        return [toolFreqHardStop(name, next), true];
      }
      if (next >= toolFreqWarn && !ts.toolFreqWarned.has(name)) {
        ts.toolFreqWarned.add(name);
        console.warn(`[LoopDetectionMiddleware] tool frequency warning`, {
          threadId,
          toolName: name,
          count: next,
        });
        return [toolFreqWarning(name, next), false];
      }
    }

    return [null, false];
  }

  const middleware = createMiddleware({
    name: 'LoopDetectionMiddleware',

    afterModel: async (state, runtime) => {
      const threadId = getThreadId(runtime);
      const [warning, hardStop] = trackAndCheck(state, threadId);

      if (hardStop) {
        const messages = state.messages;
        const last = messages[messages.length - 1] as AIMessage;
        const content = appendText(last.content, warning ?? HARD_STOP_MSG);
        const stripped = buildHardStopMessage(last, content);
        return { messages: [stripped] };
      }

      if (warning) {
        return {
          messages: [new HumanMessage({ content: warning, name: 'loop_warning' })],
        };
      }

      return undefined;
    },
  });

  // 暴露 reset，方便测试或长驻进程主动清理
  return Object.assign(middleware, {
    reset: (threadId?: string) => tracker.reset(threadId),
  });
}

/** 默认实例（始终启用，沿用默认阈值）。 */
export const loopDetectionMiddleware = createLoopDetectionMiddleware();
