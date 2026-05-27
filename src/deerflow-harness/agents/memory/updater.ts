/**
 * Memory updater —— 对齐 Python `agents/memory/updater.py`。
 *
 * 流程：
 *   load current memory → 拼 prompt → LLM ainvoke → 解析 JSON → applyUpdates → save
 *
 * 与 Python 对齐的关键不变量：
 * - max_facts 限制（按 confidence 倒排截断）
 * - factConfidenceThreshold 过滤
 * - 同 content 去重（casefold trim）
 * - 上传事件清洗（_strip_upload_mentions_from_memory）
 * - correction/reinforcement hint 注入
 * - 失败安静吞没，返回 false（不抛出）
 */

import { randomUUID } from 'node:crypto';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';

import { getMemoryConfig } from './config';
import {
  formatConversationForUpdate,
  MEMORY_UPDATE_PROMPT,
} from './prompt';
import { getMemoryStorage } from './storage';
import {
  createEmptyMemory,
  Fact,
  FactCategory,
  MemoryData,
  utcNowIsoZ,
} from './types';

/* -------------------------------------------------------------------------- */
/* Model factory injection                                                     */
/* -------------------------------------------------------------------------- */

export type MemoryModelFactory = (modelName: string | null | undefined) => BaseChatModel;

let _modelFactory: MemoryModelFactory | null = null;

/** 由上层在应用启动时注入 chat model 工厂；不注入则 LLM 更新流程被禁用。 */
export function setMemoryModelFactory(factory: MemoryModelFactory | null): void {
  _modelFactory = factory;
}

export function getMemoryModelFactory(): MemoryModelFactory | null {
  return _modelFactory;
}

/* -------------------------------------------------------------------------- */
/* Manual fact CRUD —— 与 Python create/update/delete_memory_fact 对齐           */
/* -------------------------------------------------------------------------- */

export async function getMemoryData(
  agentName: string | null = null,
  userId: string | null = null,
): Promise<MemoryData> {
  return getMemoryStorage().load({ agentName, userId });
}

export async function reloadMemoryData(
  agentName: string | null = null,
  userId: string | null = null,
): Promise<MemoryData> {
  return getMemoryStorage().reload({ agentName, userId });
}

export async function clearMemoryData(
  agentName: string | null = null,
  userId: string | null = null,
): Promise<MemoryData> {
  const empty = createEmptyMemory();
  const ok = await getMemoryStorage().save(empty, { agentName, userId });
  if (!ok) throw new Error('Failed to save cleared memory data');
  return empty;
}

export async function importMemoryData(
  data: MemoryData,
  agentName: string | null = null,
  userId: string | null = null,
): Promise<MemoryData> {
  const storage = getMemoryStorage();
  const ok = await storage.save(data, { agentName, userId });
  if (!ok) throw new Error('Failed to save imported memory data');
  return storage.load({ agentName, userId });
}

function validateConfidence(c: number): number {
  if (!Number.isFinite(c) || c < 0 || c > 1) {
    throw new RangeError(`confidence ${c} out of [0,1]`);
  }
  return c;
}

function newFactId(): string {
  return 'fact_' + randomUUID().replace(/-/g, '').slice(0, 8);
}

export async function createMemoryFact(
  content: string,
  category: FactCategory | string = 'context',
  confidence = 0.5,
  agentName: string | null = null,
  userId: string | null = null,
): Promise<MemoryData> {
  const normalized = content.trim();
  if (!normalized) throw new Error('content must be non-empty');
  const cat = ((typeof category === 'string' ? category : 'context').trim() || 'context') as FactCategory;
  const conf = validateConfidence(confidence);

  const data = await getMemoryData(agentName, userId);
  const updated: MemoryData = { ...data, facts: [...data.facts] };
  updated.facts.push({
    id: newFactId(),
    content: normalized,
    category: cat,
    confidence: conf,
    createdAt: utcNowIsoZ(),
    source: 'manual',
  });
  const ok = await getMemoryStorage().save(updated, { agentName, userId });
  if (!ok) throw new Error('Failed to save memory data after creating fact');
  return updated;
}

export async function deleteMemoryFact(
  factId: string,
  agentName: string | null = null,
  userId: string | null = null,
): Promise<MemoryData> {
  const data = await getMemoryData(agentName, userId);
  const next = data.facts.filter((f) => f.id !== factId);
  if (next.length === data.facts.length) throw new Error(`fact not found: ${factId}`);
  const updated: MemoryData = { ...data, facts: next };
  const ok = await getMemoryStorage().save(updated, { agentName, userId });
  if (!ok) throw new Error(`Failed to save memory after deleting fact ${factId}`);
  return updated;
}

export async function updateMemoryFact(
  factId: string,
  patch: { content?: string | null; category?: string | null; confidence?: number | null },
  agentName: string | null = null,
  userId: string | null = null,
): Promise<MemoryData> {
  const data = await getMemoryData(agentName, userId);
  const next: Fact[] = [];
  let found = false;
  for (const f of data.facts) {
    if (f.id !== factId) {
      next.push(f);
      continue;
    }
    found = true;
    const u: Fact = { ...f };
    if (patch.content != null) {
      const c = String(patch.content).trim();
      if (!c) throw new Error('content must be non-empty');
      u.content = c;
    }
    if (patch.category != null) {
      u.category = ((String(patch.category).trim() || 'context') as FactCategory);
    }
    if (patch.confidence != null) {
      u.confidence = validateConfidence(Number(patch.confidence));
    }
    next.push(u);
  }
  if (!found) throw new Error(`fact not found: ${factId}`);
  const updated: MemoryData = { ...data, facts: next };
  const ok = await getMemoryStorage().save(updated, { agentName, userId });
  if (!ok) throw new Error(`Failed to save memory after updating fact ${factId}`);
  return updated;
}

/* -------------------------------------------------------------------------- */
/* Strip upload mentions —— 对齐 Python `_strip_upload_mentions_from_memory`     */
/* -------------------------------------------------------------------------- */

const UPLOAD_SENTENCE_RE =
  /[^.!?]*\b(?:upload(?:ed|ing)?(?:\s+\w+){0,3}\s+(?:file|files?|document|documents?|attachment|attachments?)|file\s+upload|\/mnt\/user-data\/uploads\/|<uploaded_files>)[^.!?]*[.!?]?\s*/gi;

function stripUploadMentions(memory: MemoryData): MemoryData {
  const out: MemoryData = JSON.parse(JSON.stringify(memory));
  for (const sec of ['user', 'history'] as const) {
    const section = out[sec] as unknown as Record<string, { summary: string; updatedAt: string }>;
    for (const k of Object.keys(section)) {
      const v = section[k];
      if (v && typeof v.summary === 'string') {
        v.summary = v.summary.replace(UPLOAD_SENTENCE_RE, '').replace(/  +/g, ' ').trim();
      }
    }
  }
  if (Array.isArray(out.facts)) {
    out.facts = out.facts.filter((f) => !UPLOAD_SENTENCE_RE.test(f.content ?? ''));
    // 重置 lastIndex（全局 regex test 副作用）
    UPLOAD_SENTENCE_RE.lastIndex = 0;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Apply updates                                                               */
/* -------------------------------------------------------------------------- */

function factContentKey(content: any): string | null {
  if (typeof content !== 'string') return null;
  const s = content.trim();
  if (!s) return null;
  return s.toLocaleLowerCase();
}

function applyUpdates(
  current: MemoryData,
  update: any,
  threadId: string | null,
): MemoryData {
  const cfg = getMemoryConfig();
  const now = utcNowIsoZ();
  const out: MemoryData = JSON.parse(JSON.stringify(current));

  // user sections
  const userUpdates = update?.user ?? {};
  for (const key of ['workContext', 'personalContext', 'topOfMind'] as const) {
    const sec = userUpdates[key];
    if (sec && sec.shouldUpdate && typeof sec.summary === 'string' && sec.summary.length > 0) {
      out.user[key] = { summary: sec.summary, updatedAt: now };
    }
  }

  // history sections
  const histUpdates = update?.history ?? {};
  for (const key of ['recentMonths', 'earlierContext', 'longTermBackground'] as const) {
    const sec = histUpdates[key];
    if (sec && sec.shouldUpdate && typeof sec.summary === 'string' && sec.summary.length > 0) {
      out.history[key] = { summary: sec.summary, updatedAt: now };
    }
  }

  // remove facts
  const removeIds = new Set<string>(
    Array.isArray(update?.factsToRemove) ? update.factsToRemove.filter((x: any) => typeof x === 'string') : [],
  );
  if (removeIds.size > 0) {
    out.facts = out.facts.filter((f) => !removeIds.has(f.id));
  }

  // add new facts
  const existingKeys = new Set<string>();
  for (const f of out.facts) {
    const k = factContentKey(f.content);
    if (k) existingKeys.add(k);
  }
  const newFacts: any[] = Array.isArray(update?.newFacts) ? update.newFacts : [];
  for (const f of newFacts) {
    const conf = typeof f?.confidence === 'number' ? f.confidence : 0.5;
    if (conf < cfg.factConfidenceThreshold) continue;
    const raw = f?.content;
    if (typeof raw !== 'string') continue;
    const norm = raw.trim();
    const key = factContentKey(norm);
    if (!key || existingKeys.has(key)) continue;

    const entry: Fact = {
      id: newFactId(),
      content: norm,
      category: ((typeof f.category === 'string' && f.category) || 'context') as FactCategory,
      confidence: Math.max(0, Math.min(1, conf)),
      createdAt: now,
      source: threadId || 'unknown',
    };
    if (typeof f.sourceError === 'string') {
      const se = f.sourceError.trim();
      if (se) entry.sourceError = se;
    }
    out.facts.push(entry);
    existingKeys.add(key);
  }

  // enforce max_facts
  if (out.facts.length > cfg.maxFacts) {
    out.facts = out.facts
      .slice()
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .slice(0, cfg.maxFacts);
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Memory updater (LLM-based)                                                  */
/* -------------------------------------------------------------------------- */

function buildCorrectionHint(correction: boolean, reinforcement: boolean): string {
  const parts: string[] = [];
  if (correction) {
    parts.push(
      'IMPORTANT: Explicit correction signals were detected in this conversation. ' +
        "Pay special attention to what the agent got wrong, what the user corrected, " +
        'and record the correct approach as a fact with category ' +
        '"correction" and confidence >= 0.95 when appropriate.',
    );
  }
  if (reinforcement) {
    parts.push(
      'IMPORTANT: Positive reinforcement signals were detected in this conversation. ' +
        "The user explicitly confirmed the agent's approach was correct or helpful. " +
        'Record the confirmed approach, style, or preference as a fact with category ' +
        '"preference" or "behavior" and confidence >= 0.9 when appropriate.',
    );
  }
  return parts.join('\n');
}

function extractText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const pieces: string[] = [];
    let pending: string[] = [];
    const flush = () => {
      if (pending.length > 0) {
        pieces.push(pending.join(''));
        pending = [];
      }
    };
    for (const block of content) {
      if (typeof block === 'string') {
        pending.push(block);
      } else if (block && typeof block === 'object') {
        flush();
        if (typeof (block as any).text === 'string') pieces.push((block as any).text);
      }
    }
    flush();
    return pieces.join('\n');
  }
  return content == null ? '' : String(content);
}

/**
 * 尝试从被截断的 JSON 字符串中抢救一个可解析的对象片段。
 *
 * 策略：从右往左找最后一个 `}`，按"之前的 `{` 与 `}` 数量平衡"为终点切掉
 * 后续不完整内容。用于 LLM `finish_reason=length` 时输出尾部缺失的场景。
 * 不做激进的 JSON 重写——只切到最近一个完整对象边界，避免造出错误数据。
 */
function tryRecoverJson(text: string): string | null {
  const s = text.trim();
  if (!s.startsWith('{')) return null;
  let depth = 0;
  let lastValidEnd = -1;
  let inStr = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) lastValidEnd = i;
    }
  }
  if (lastValidEnd <= 0) return null;
  return s.slice(0, lastValidEnd + 1);
}

export interface UpdateMemoryOptions {
  threadId?: string | null;
  agentName?: string | null;
  userId?: string | null;
  correctionDetected?: boolean;
  reinforcementDetected?: boolean;
}

export class MemoryUpdater {
  constructor(private readonly modelName: string | null = null) {}

  private getModel(): BaseChatModel | null {
    const factory = getMemoryModelFactory();
    if (!factory) return null;
    const cfg = getMemoryConfig();
    return factory(this.modelName ?? cfg.modelName);
  }

  async updateMemory(messages: any[], opts: UpdateMemoryOptions = {}): Promise<boolean> {
    const cfg = getMemoryConfig();
    if (!cfg.enabled) return false;
    if (!Array.isArray(messages) || messages.length === 0) return false;

    try {
      const conversation = formatConversationForUpdate(messages);
      if (!conversation.trim()) return false;

      const agentName = opts.agentName ?? null;
      const userId = opts.userId ?? null;

      const current = await getMemoryData(agentName, userId);
      const correctionHint = buildCorrectionHint(
        Boolean(opts.correctionDetected),
        Boolean(opts.reinforcementDetected),
      );

      // 与 Python 对齐：用占位符直接 replace，避免 JS 模板字符串语义冲突
      const prompt = MEMORY_UPDATE_PROMPT.replace('{current_memory}', JSON.stringify(current, null, 2))
        .replace('{conversation}', conversation)
        .replace('{correction_hint}', correctionHint);

      const model = this.getModel();
      if (!model) {
        console.warn('[memory/updater] No model factory configured; skip LLM update.');
        return false;
      }

      // 关键：显式 callbacks: [] 切断与外层（HTTP SSE）的 callback handler 链。
      // 否则该 LLM 调用会把 token 推到主请求那条已关闭的 ReadableStream，
      // 触发 `ERR_INVALID_STATE: Controller is already closed`。
      const response = await model.invoke(prompt, {
        runName: 'memory_agent',
        callbacks: [],
        tags: ['memory-updater'],
      } as any);
      let text = extractText((response as any)?.content).trim();
      if (text.startsWith('```')) {
        const lines = text.split('\n');
        text = (lines[lines.length - 1] === '```' ? lines.slice(1, -1) : lines.slice(1)).join('\n');
      }

      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        // 兜底：尝试截到最近一个外层闭合大括号再解析一次。Qwen 在 maxTokens
        // 触顶或 streaming=false 整段返回时偶发会缺最后几个字符（尾部 ", \n}"
        // 这种），但前面绝大多数字段已经合法。能恢复就恢复，不能就放弃。
        const fallback = tryRecoverJson(text);
        if (fallback) {
          console.warn(
            '[memory/updater] LLM JSON parse failed, recovered via brace trim:',
            (e as Error).message,
            { len: text.length, recoveredLen: fallback.length },
          );
          try {
            parsed = JSON.parse(fallback);
          } catch (e2) {
            console.warn(
              '[memory/updater] LLM JSON recovery still failed:',
              (e2 as Error).message,
              { len: text.length, tail: text.slice(-120) },
            );
            return false;
          }
        } else {
          console.warn(
            '[memory/updater] Failed to parse LLM JSON:',
            (e as Error).message,
            { len: text.length, tail: text.slice(-120) },
          );
          return false;
        }
      }

      let updated = applyUpdates(current, parsed, opts.threadId ?? null);
      updated = stripUploadMentions(updated);

      return await getMemoryStorage().save(updated, { agentName, userId });
    } catch (e) {
      console.error('[memory/updater] Memory update failed:', e);
      return false;
    }
  }
}

export async function updateMemoryFromConversation(
  messages: any[],
  opts: UpdateMemoryOptions = {},
): Promise<boolean> {
  const updater = new MemoryUpdater();
  return updater.updateMemory(messages, opts);
}
