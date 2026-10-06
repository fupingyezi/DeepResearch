/**
 * Memory updater
 *
 * 流程：
 *   load current memory → 拼 prompt → LLM ainvoke → 解析 JSON
 *   → 锁外预演（applyUpdates + strip + 嵌向量）→ 锁内 RMW（applyUpdates 重跑 + 守卫合并向量）→ save
 *
 * - max_facts 限制（按 confidence 倒排截断）
 * - factConfidenceThreshold 过滤
 * - 同 content 去重（Unicode casefold + trim）
 * - 上传事件清洗（_strip_upload_mentions_from_memory）
 * - correction/reinforcement hint 注入
 * - 失败安静吞没，返回 false（不抛出）
 */

import { randomUUID } from 'node:crypto';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';

import { getMemoryConfig } from './config';
import { embedQuery, embedTexts, isCompatibleVector, RECALL_SECTION_SLOTS } from './embeddings';
import { formatConversationForUpdate, MEMORY_UPDATE_PROMPT } from './prompt';
import { getMemoryStorage } from './storage';
import {
  createEmptyMemory,
  Fact,
  FactCategory,
  MemoryData,
  SectionData,
  utcNowIsoZ,
} from './types';
import { casefold, extractMessageContentText } from '@/utils/common';

// Model factory injection
export type MemoryModelFactory = (modelName: string | null | undefined) => BaseChatModel;

let _modelFactory: MemoryModelFactory | null = null;

/** 由上层在应用启动时注入 chat model 工厂；不注入则 LLM 更新流程被禁用。 */
export function setMemoryModelFactory(factory: MemoryModelFactory | null): void {
  _modelFactory = factory;
}

export function getMemoryModelFactory(): MemoryModelFactory | null {
  return _modelFactory;
}

// Manual fact CRUD

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

/**
 * 为 facts 中缺失 / 维度失效的条目批量生成向量（≤ ceil(n/64) 次请求）。
 * 嵌入失败（稀疏 null）时保持无向量原样返回，交由检索侧回填重试。
 * 注意：以整槽替换（不 mutate 元素）写入，避免触碰 storage 缓存里的原对象。
 */
async function embedMissingFacts(data: MemoryData): Promise<void> {
  const config = getMemoryConfig();
  if (!config.embeddingEnabled) return;
  const idx: number[] = [];
  data.facts.forEach((f, i) => {
    if (!isCompatibleVector(f.embedding, config.embeddingDimensions)) idx.push(i);
  });
  if (idx.length === 0) return;
  const vectors = await embedTexts(idx.map((i) => data.facts[i].content));
  idx.forEach((i, k) => {
    if (vectors[k] != null) data.facts[i] = { ...data.facts[i], embedding: vectors[k]! };
  });
}

/**
 * 为参与召回的 sections（RECALL_SECTION_SLOTS）补齐缺失 / 维度失效的向量。
 * 与 embedMissingFacts 同纪律：整槽替换（不 mutate 元素本身，data 是 updater 私有
 * 深拷贝，槽位容器可直接写）、失败保持无向量交由检索侧回填重试。
 */
async function embedMissingSections(data: MemoryData): Promise<void> {
  const config = getMemoryConfig();
  if (!config.embeddingEnabled) return;
  const slots: Array<['user' | 'history', string]> = [];
  for (const [group, key] of RECALL_SECTION_SLOTS) {
    const container = data[group] as unknown as Record<string, SectionData>;
    const section = container[key];
    if (section?.summary && !isCompatibleVector(section.embedding, config.embeddingDimensions)) {
      slots.push([group, key]);
    }
  }
  if (slots.length === 0) return;
  const vectors = await embedTexts(
    slots.map(
      ([group, key]) => (data[group] as unknown as Record<string, SectionData>)[key].summary,
    ),
  );
  slots.forEach(([group, key], k) => {
    if (vectors[k] != null) {
      const container = data[group] as unknown as Record<string, SectionData>;
      container[key] = { ...container[key], embedding: vectors[k]! };
    }
  });
}

/**
 * 构造 LLM 更新 prompt 前剥离 facts 与 sections 的 embedding 向量：
 * 100 条 facts × 1024 维浮点会把 prompt 撑到 MB 级，直接不可用。
 */
function sanitizeMemoryForPrompt(memory: MemoryData): MemoryData {
  const stripSection = (sec: SectionData): SectionData => {
    if (sec.embedding == null) return sec;
    const rest = { ...sec };
    delete rest.embedding;
    return rest;
  };
  return {
    ...memory,
    user: {
      workContext: stripSection(memory.user.workContext),
      personalContext: stripSection(memory.user.personalContext),
      topOfMind: stripSection(memory.user.topOfMind),
    },
    history: {
      recentMonths: stripSection(memory.history.recentMonths),
      earlierContext: stripSection(memory.history.earlierContext),
      longTermBackground: stripSection(memory.history.longTermBackground),
    },
    facts: (memory.facts ?? []).map((f) => {
      if (f.embedding == null) return f;
      const rest = { ...f };
      delete rest.embedding;
      return rest;
    }),
  };
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
  const cat = ((typeof category === 'string' ? category : 'context').trim() ||
    'context') as FactCategory;
  const conf = validateConfidence(confidence);

  const entry: Fact = {
    id: newFactId(),
    content: normalized,
    category: cat,
    confidence: conf,
    createdAt: utcNowIsoZ(),
    source: 'manual',
  };
  // 顺手生成语义向量（失败不阻塞创建，交由回填重试）——在锁外做：API 调用不进临界区
  if (getMemoryConfig().embeddingEnabled) {
    const vector = await embedQuery(normalized);
    if (vector) entry.embedding = vector;
  }
  const result = await getMemoryStorage().update(
    (data) => ({ ...data, facts: [...data.facts, entry] }),
    { agentName, userId },
  );
  if (!result) throw new Error('Failed to save memory data after creating fact');
  return result;
}

export async function deleteMemoryFact(
  factId: string,
  agentName: string | null = null,
  userId: string | null = null,
): Promise<MemoryData> {
  // 存在性检查放在 mutator 内：对锁内最新数据判定，而不是调用方读到的旧快照
  const result = await getMemoryStorage().update(
    (data) => {
      const next = data.facts.filter((f) => f.id !== factId);
      if (next.length === data.facts.length) throw new Error(`fact not found: ${factId}`);
      return { ...data, facts: next };
    },
    { agentName, userId },
  );
  if (!result) throw new Error(`Failed to save memory after deleting fact ${factId}`);
  return result;
}

export async function updateMemoryFact(
  factId: string,
  patch: { content?: string | null; category?: string | null; confidence?: number | null },
  agentName: string | null = null,
  userId: string | null = null,
): Promise<MemoryData> {
  // 整个 patch + 重向量化在 mutator 内完成：content 是否真的变了要在锁内最新数据上
  // 判定，否则「变更即重嵌」可能基于过期内容，写入的向量对不上落盘的新 content。
  const result = await getMemoryStorage().update(
    async (data) => {
      const next: Fact[] = [];
      let found = false;
      let contentChanged = false;
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
          if (c !== u.content) contentChanged = true;
          u.content = c;
          delete u.embedding; // 旧向量对新 content 失效
        }
        if (patch.category != null) {
          u.category = (String(patch.category).trim() || 'context') as FactCategory;
        }
        if (patch.confidence != null) {
          u.confidence = validateConfidence(Number(patch.confidence));
        }
        next.push(u);
      }
      if (!found) throw new Error(`fact not found: ${factId}`);
      // content 变更后重新向量化（失败保持无向量，交由回填重试）
      if (contentChanged && getMemoryConfig().embeddingEnabled) {
        const target = next.find((f) => f.id === factId);
        if (target) {
          const vector = await embedQuery(target.content);
          if (vector) target.embedding = vector;
        }
      }
      return { ...data, facts: next };
    },
    { agentName, userId },
  );
  if (!result) throw new Error(`Failed to save memory after updating fact ${factId}`);
  return result;
}

// Strip upload mentions

// \b 只收进以词字符开头的两个英文分支：/mnt 路径与 <uploaded_files> 标签以非词字符
// 开头，前置字符是中文/空格时「非词→非词」不构成词边界，组外的 \b 会让这两个分支永不命中
const UPLOAD_SENTENCE_RE =
  /[^.!?]*(?:\bupload(?:ed|ing)?(?:\s+\w+){0,3}\s+(?:file|files?|document|documents?|attachment|attachments?)|\bfile\s+upload|\/mnt\/user-data\/uploads\/|<uploaded_files>)[^.!?]*[.!?]?\s*/gi;
// 判定用无 g 副本：带 g 的 test() 会推进 lastIndex，filter 跨迭代复用会让后续条目从
// 上次命中的位置起匹配而漏检（replace 不受影响——它自行管理 lastIndex）。
const UPLOAD_TEST_RE = new RegExp(UPLOAD_SENTENCE_RE.source, 'i');

function stripUploadMentions(memory: MemoryData): MemoryData {
  // 惰性拷贝：无变更时返回原引用——pg-storage.update 以 `next === current`
  // 判等跳过落盘写，无条件深拷贝会让每轮无变更更新也全量重写
  let out: MemoryData = memory;
  for (const sec of ['user', 'history'] as const) {
    // UserSection / HistorySection 的字段是字面量 key 而非索引签名，TS 不允许
    // 直接断言为 Record<string, SectionData>，需要先经 unknown 中转。
    const section = out[sec] as unknown as Record<string, SectionData>;
    for (const k of Object.keys(section)) {
      const v = section[k];
      if (v && typeof v.summary === 'string') {
        const next = v.summary.replace(UPLOAD_SENTENCE_RE, '').replace(/  +/g, ' ').trim();
        if (next !== v.summary) {
          if (out === memory) out = JSON.parse(JSON.stringify(memory));
          const copySection = out[sec] as unknown as Record<string, SectionData>;
          copySection[k].summary = next;
          // 文本变了，旧向量失效，由 embedMissingSections / 回填重嵌
          delete copySection[k].embedding;
        }
      }
    }
  }
  if (Array.isArray(out.facts)) {
    const kept = out.facts.filter((f) => !UPLOAD_TEST_RE.test(f.content ?? ''));
    if (kept.length !== out.facts.length) {
      if (out === memory) out = JSON.parse(JSON.stringify(memory));
      out.facts = kept;
    }
  }
  return out;
}

// Apply updates

function factContentKey(content: any): string | null {
  if (typeof content !== 'string') return null;
  const s = content.trim();
  if (!s) return null;
  return casefold(s).normalize('NFC');
}

function applyUpdates(current: MemoryData, update: any, threadId: string | null): MemoryData {
  const config = getMemoryConfig();
  const now = utcNowIsoZ();
  // 惰性拷贝：全部无变更时返回 current 本身（见 stripUploadMentions 同款注释）
  let out: MemoryData = current;
  const copy = (): MemoryData => {
    if (out !== current) return out;
    out = JSON.parse(JSON.stringify(current));
    return out;
  };

  // user sections：summary 未变（trim 后相等）保留原槽——连带旧向量与 updatedAt，
  // 避免无谓重嵌；重写则整槽替换，旧向量随新对象自然丢弃，由 embedMissingSections 重嵌
  const userUpdates = update?.user ?? {};
  for (const key of ['workContext', 'personalContext', 'topOfMind'] as const) {
    const sec = userUpdates[key];
    if (sec && sec.shouldUpdate && typeof sec.summary === 'string' && sec.summary.length > 0) {
      if (sec.summary.trim() === out.user[key].summary?.trim()) continue;
      copy().user[key] = { summary: sec.summary, updatedAt: now };
    }
  }

  // history sections（同 user sections 的未变保留策略）
  const histUpdates = update?.history ?? {};
  for (const key of ['recentMonths', 'earlierContext', 'longTermBackground'] as const) {
    const sec = histUpdates[key];
    if (sec && sec.shouldUpdate && typeof sec.summary === 'string' && sec.summary.length > 0) {
      if (sec.summary.trim() === out.history[key].summary?.trim()) continue;
      copy().history[key] = { summary: sec.summary, updatedAt: now };
    }
  }

  // remove facts
  const removeIds = new Set<string>(
    Array.isArray(update?.factsToRemove)
      ? update.factsToRemove.filter((x: any) => typeof x === 'string')
      : [],
  );
  if (removeIds.size > 0) {
    const kept = out.facts.filter((f) => !removeIds.has(f.id));
    if (kept.length !== out.facts.length) {
      copy().facts = kept;
    }
  }

  // add new facts
  const existingKeys = new Set<string>();
  for (const f of out.facts) {
    const k = factContentKey(f.content);
    if (k) existingKeys.add(k);
  }
  const newFacts: any[] = Array.isArray(update?.newFacts) ? update.newFacts : [];
  const toAdd: Fact[] = [];
  for (const f of newFacts) {
    const conf = typeof f?.confidence === 'number' ? f.confidence : 0.5;
    if (conf < config.factConfidenceThreshold) continue;
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
    toAdd.push(entry);
    existingKeys.add(key);
  }
  if (toAdd.length > 0) {
    copy().facts.push(...toAdd);
  }

  // enforce max_facts
  if (out.facts.length > config.maxFacts) {
    copy().facts = out.facts
      .slice()
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .slice(0, config.maxFacts);
  }

  return out;
}

/**
 * 把锁外预演的嵌入结果并回锁内重跑出的最新状态。
 *
 * 守卫与回填合并同纪律：facts 按 content key（不能按 id——锁内重跑给同一批
 * 新 fact 生成的新 id 与 draft 不同）、sections 按槽位+summary 比对，嵌入期间
 * 被并发写改动过的条目旧向量作废，交检索侧回填重嵌。
 */
function mergePreembeddedVectors(updated: MemoryData, draft: MemoryData): MemoryData {
  const config = getMemoryConfig();
  let result = updated;

  const preByContent = new Map<string, number[]>();
  for (const f of draft.facts) {
    const key = factContentKey(f.content);
    if (key && isCompatibleVector(f.embedding, config.embeddingDimensions)) {
      preByContent.set(key, f.embedding as number[]);
    }
  }
  if (preByContent.size > 0) {
    const mergedFacts = updated.facts.map((f) => {
      const key = factContentKey(f.content);
      const vector = key ? preByContent.get(key) : null;
      if (!vector) return f;
      // 锁内已有合法向量（并发写已嵌）不覆盖
      if (isCompatibleVector(f.embedding, config.embeddingDimensions)) return f;
      return { ...f, embedding: vector };
    });
    if (mergedFacts.some((f, i) => f !== updated.facts[i])) {
      result = { ...updated, facts: mergedFacts };
    }
  }

  for (const [group, slot] of RECALL_SECTION_SLOTS) {
    const container = result[group] as unknown as Record<string, SectionData>;
    const current = container[slot];
    if (!current?.summary) continue;
    if (isCompatibleVector(current.embedding, config.embeddingDimensions)) continue;
    const pre = (draft[group] as unknown as Record<string, SectionData>)[slot];
    if (!pre?.summary || pre.summary !== current.summary) continue;
    if (!isCompatibleVector(pre.embedding, config.embeddingDimensions)) continue;
    // 逐槽重建容器与顶层对象，不 mutate updated 的对象图
    result =
      group === 'user'
        ? {
            ...result,
            user: { ...result.user, [slot]: { ...current, embedding: pre.embedding as number[] } },
          }
        : {
            ...result,
            history: {
              ...result.history,
              [slot]: { ...current, embedding: pre.embedding as number[] },
            },
          };
  }

  return result;
}

// Memory updater（LLM-based）

function buildCorrectionHint(correction: boolean, reinforcement: boolean): string {
  const parts: string[] = [];
  if (correction) {
    parts.push(
      'IMPORTANT: Explicit correction signals were detected in this conversation. ' +
        'Pay special attention to what the agent got wrong, what the user corrected, ' +
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

/**
 * 记忆更新的计数器 —— 「更新失败」的可观测出口。
 *
 * 更新失败的形态是**静默丢事实**（模型顶到 maxTokens → 响应为空或被截断 →
 * JSON 解析失败 → 跳过本次更新），后果是记忆里少了若干条事实、评测的 memory
 * 相关指标默默变差。基准测试会把这两个数写进报告（`memoryUpdateFailures`），
 * 产品侧也可据此做监控。
 */
const memoryUpdateStats = { attempted: 0, succeeded: 0, failed: 0 };

export function getMemoryUpdateStats(): { attempted: number; succeeded: number; failed: number } {
  return { ...memoryUpdateStats };
}

export class MemoryUpdater {
  constructor(private readonly modelName: string | null = null) {}

  private getModel(): BaseChatModel | null {
    const factory = getMemoryModelFactory();
    if (!factory) return null;
    const config = getMemoryConfig();
    return factory(this.modelName ?? config.modelName);
  }

  async updateMemory(messages: any[], opts: UpdateMemoryOptions = {}): Promise<boolean> {
    const config = getMemoryConfig();
    if (!config.enabled) return false;
    if (!Array.isArray(messages) || messages.length === 0) return false;

    memoryUpdateStats.attempted += 1;
    /** 记账后返回 false，避免每条失败路径都要记得手动 ++ */
    const fail = (): false => {
      memoryUpdateStats.failed += 1;
      return false;
    };

    try {
      const conversation = formatConversationForUpdate(messages);
      if (!conversation.trim()) return fail();

      const agentName = opts.agentName ?? null;
      const userId = opts.userId ?? null;

      const current = await getMemoryData(agentName, userId);
      const correctionHint = buildCorrectionHint(
        Boolean(opts.correctionDetected),
        Boolean(opts.reinforcementDetected),
      );

      // 用占位符直接 replace，避免 JS 模板字符串语义冲突；
      // current 先剥离 embedding 向量（防 MB 级 prompt，见 sanitizeMemoryForPrompt）
      const prompt = MEMORY_UPDATE_PROMPT.replace(
        '{current_memory}',
        JSON.stringify(sanitizeMemoryForPrompt(current), null, 2),
      )
        .replace('{conversation}', conversation)
        .replace('{correction_hint}', correctionHint);

      const model = this.getModel();
      if (!model) {
        console.warn('[memory/updater] No model factory configured; skip LLM update.');
        return fail();
      }

      // 关键：显式 callbacks: [] 切断与外层（HTTP SSE）的 callback handler 链。
      // 防止LLM 调用把 token 推到主请求那条已关闭的 ReadableStream，
      // 触发 `ERR_INVALID_STATE: Controller is already closed`。
      // signal 给 LLM 调用加超时：挂起会永久占住队列的 processing 标记、
      // 后续所有线程的记忆更新全部堆积（ChatOpenAI 透传 AbortSignal 到 SDK）。
      const response = await model.invoke(prompt, {
        runName: 'memory_agent',
        callbacks: [],
        tags: ['memory-updater'],
        signal: AbortSignal.timeout(getMemoryConfig().updateTimeoutMs),
      });
      const responseContent = response.content;
      let text = extractMessageContentText(responseContent).trim();
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
            return fail();
          }
        } else {
          console.warn('[memory/updater] Failed to parse LLM JSON:', (e as Error).message, {
            len: text.length,
            tail: text.slice(-120),
          });
          return fail();
        }
      }

      // 锁外嵌入：在最新快照上预演 applyUpdates + stripUploadMentions 得 draft
      // （两者都是纯函数，锁内会在 fresh 上重跑），对 draft 里缺向量的条目调 embedTexts。
      // 嵌入是 HTTP 调用，不能持行锁——那会把同用户的并发写阻塞在网络上。
      // 必须在 stripUploadMentions 之后嵌：strip 会改写 section summary，先嵌会产生立刻失效的向量
      let draft: MemoryData | null = null;
      if (getMemoryConfig().embeddingEnabled) {
        try {
          const latest = await getMemoryStorage().reload({ agentName, userId });
          draft = stripUploadMentions(applyUpdates(latest, parsed, opts.threadId ?? null));
          await embedMissingSections(draft);
          await embedMissingFacts(draft);
        } catch (e) {
          // 预演失败不阻断更新：向量留待检索侧回填
          draft = null;
        }
      }

      // 锁内 RMW：applyUpdates 重新作用于锁内的最新盘上状态。current 是 LLM 调用
      // 前读的快照（期间其它进程可能已落盘），直接 save 会把它覆盖掉。
      const saved = await getMemoryStorage().update(
        (fresh) => {
          let updated = applyUpdates(fresh, parsed, opts.threadId ?? null);
          updated = stripUploadMentions(updated);
          return draft ? mergePreembeddedVectors(updated, draft) : updated;
        },
        { agentName, userId },
      );
      // saved === null（存储写失败）是独立于「抛错」的失败形态，必须计入 failed，
      // 否则 attempted ≠ succeeded + failed，写失败会从计数器里静默消失
      if (saved) memoryUpdateStats.succeeded += 1;
      else memoryUpdateStats.failed += 1;
      return !!saved;
    } catch (e) {
      // 超时是独立故障形态（LLM 挂起被 signal 打断）：单独告警便于区分
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        console.warn(
          `[memory/updater] LLM update timed out after ${getMemoryConfig().updateTimeoutMs}ms, skipping this round:`,
          e,
        );
      } else {
        console.error('[memory/updater] Memory update failed:', e);
      }
      return fail();
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
