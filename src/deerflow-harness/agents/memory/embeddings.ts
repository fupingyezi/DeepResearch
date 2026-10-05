/**
 * Memory embeddings（智谱 embedding-3 语义检索基础设施）
 *
 * 设计要点：
 * - 工厂注入：app 层（src/server/wiring.ts）注册具体的 Embeddings 构造器，
 *   未注册 / 构造失败 / API 失败时所有出口静默降级（返回 null / 稀疏数组），
 *   **绝不抛出** —— 对应决策「无向量 / 无 Key / API 失败自动回落关键词检索」。
 * - 智谱 embedding-3 单请求最多 64 条文本：embedTexts 手动按批切片，
 *   不依赖 OpenAIEmbeddings 自带 batchSize（后端无关、便于 mock 测试）。
 * - 旧数据回填：backfillMemoryEmbeddings 补齐缺失 / 维度不匹配的 fact 与
 *   section 向量，进程内 per-storage-key 去重；嵌入完成后重新 reload 再合并保存，
 *   只补「仍存在且 content / summary 未变」的条目，尽量避开与 LLM updater 的并发写互踩。
 */

import type { Embeddings } from '@langchain/core/embeddings';

import { getMemoryConfig } from './config';
import { getMemoryStorage } from './storage';
import type { Fact, MemoryData, SectionData } from './types';

export type MemoryEmbeddingsFactory = () => Embeddings | null;

let _factory: MemoryEmbeddingsFactory | null = null;
let warnedEmbedFailure = false;
let warnedBackfillFailure = false;
/** 按 key 去重的告警（避免每轮检索刷屏）。 */
const warnedKeys = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(message);
}

export function setMemoryEmbeddingsFactory(factory: MemoryEmbeddingsFactory | null): void {
  _factory = factory;
}

export function getMemoryEmbeddingsFactory(): MemoryEmbeddingsFactory | null {
  return _factory;
}

/** 仅供测试使用：重置工厂与告警标志。 */
export function resetMemoryEmbeddingsFactory(): void {
  _factory = null;
  warnedEmbedFailure = false;
  warnedBackfillFailure = false;
  warnedKeys.clear();
}

/** 智谱 embedding-3 单请求输入条数上限。 */
export const EMBEDDING_BATCH_LIMIT = 64;

/**
 * 维度守卫：返回向量的长度必须与配置一致。
 *
 * 存在的意义：provider/SDK 层面的编码格式不一致会让向量**静默地**变成另一个长度且
 * 数值无意义（实测：OpenAI SDK 默认按 base64 解码 + 智谱忽略该参数 → 1024 维被当成
 * 字节流重解释成 256 个乱数），余弦算出 NaN，混合检索悄悄退回词面检索而毫无报错。
 * 这里把「长度不符」显式识别出来并按失败处理（回落词面），同时告警一次。
 */
function isExpectedLength(vector: unknown): vector is number[] {
  const { embeddingDimensions } = getMemoryConfig();
  if (!Array.isArray(vector)) return false;
  if (vector.length === embeddingDimensions) return true;
  warnOnce(
    `vector-dimension-mismatch:${vector.length}`,
    `[memory/embeddings] 返回向量维度 ${vector.length} 与配置 embeddingDimensions=${embeddingDimensions} 不符，` +
      `已按失败处理（回落词面检索）。请检查 embedding provider 的编码格式/维度参数。`,
  );
  return false;
}

/** 单条文本向量化；工厂缺失 / 失败 / 空文本 / 维度不符 → null（调用方回落 lexical）。 */
export async function embedQuery(text: string): Promise<number[] | null> {
  if (!text.trim()) return null;
  const embeddings = createEmbeddingsInstance();
  if (!embeddings) return null;
  try {
    const vector = await embeddings.embedQuery(text);
    return isExpectedLength(vector) ? vector : null;
  } catch (e) {
    warnEmbedFailureOnce('embedQuery', e);
    return null;
  }
}

/**
 * 批量向量化：按 EMBEDDING_BATCH_LIMIT 手动切片串行调用。
 * 任一批失败只把该批置 null（稀疏数组），不影响其余批次；工厂缺失 → 全 null。
 */
export async function embedTexts(texts: string[]): Promise<(number[] | null)[]> {
  const out: (number[] | null)[] = new Array(texts.length).fill(null);
  if (texts.length === 0) return out;
  const embeddings = createEmbeddingsInstance();
  if (!embeddings) return out;

  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_LIMIT) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_LIMIT);
    try {
      const vectors = await embeddings.embedDocuments(batch);
      for (let j = 0; j < batch.length; j++) {
        const vector = vectors[j];
        out[i + j] = isExpectedLength(vector) ? vector : null;
      }
    } catch (e) {
      warnEmbedFailureOnce(`embedDocuments(batch #${Math.floor(i / EMBEDDING_BATCH_LIMIT)})`, e);
    }
  }
  return out;
}

/** 余弦相似度；零向量（方向无定义）按 0 处理。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/** 结构 + 维度校验：数组、长度与 dims 一致、全部为有限数字。 */
export function isCompatibleVector(v: unknown, dims: number): v is number[] {
  if (!Array.isArray(v) || v.length !== dims) return false;
  return v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/** 进程内 in-flight 去重（key: `${userId}::${agentName}`）。 */
const backfillInFlight = new Set<string>();

/**
 * 参与检索打分的 section 槽位（topOfMind + history 三段）。
 * 恒保留的 workContext/personalContext 不参与打分，不嵌向量——
 * 1024 维浮点数组 JSON 序列化每条约 15-20KB，无决策作用的向量纯占体积。
 * 写入侧补齐（updater.embedMissingSections）与回填共用此集合。
 */
export const SCORED_SECTION_SLOTS = [
  ['user', 'topOfMind'],
  ['history', 'recentMonths'],
  ['history', 'earlierContext'],
  ['history', 'longTermBackground'],
] as const;

/** 按 group/slot 取 section；UserSection/HistorySection 字面量 key 需经 unknown 中转索引。 */
function scoredSection(data: MemoryData, group: 'user' | 'history', slot: string): SectionData {
  return (
    (data[group] as unknown as Record<string, SectionData>)[slot] ?? { summary: '', updatedAt: '' }
  );
}

/**
 * 回填旧数据：为缺失 / 维度不匹配的 facts 与打分 sections 补齐向量并落盘。
 * 检索侧命中后 fire-and-forget 调用，失败静默（warn 一次）。
 *
 * facts 与 sections 合并在同一函数、同一 in-flight 锁、同一次 embed 批里处理——
 * 两个独立回填各自 reload-merge-save 会互相制造「A 合并前 B 已 save → A 丢掉 B」
 * 的交错窗口，合并后单次 save 彻底消除这对竞态。
 *
 * 并发语义：嵌入在锁外进行，期间 updater 可能落盘新内容；落盘走 update 的锁内
 * 合并，只合入「仍存在且 content / summary 未变」的条目（facts 按 id+content、
 * sections 按槽位+summary 守卫），与 updater 的写互斥（同一 per-user 锁）。
 */
export async function backfillMemoryEmbeddings(opts: {
  agentName?: string | null;
  userId?: string | null;
}): Promise<void> {
  const scope = { agentName: opts.agentName ?? null, userId: opts.userId ?? null };
  const key = `${scope.userId ?? ''}::${scope.agentName ?? ''}`;
  if (backfillInFlight.has(key)) return;

  const config = getMemoryConfig();
  if (!config.embeddingEnabled) return;

  backfillInFlight.add(key);
  try {
    const storage = getMemoryStorage();
    const latest = await storage.reload(scope);

    const missingFacts = latest.facts.filter(
      (f) => !isCompatibleVector(f.embedding, config.embeddingDimensions),
    );
    const missingSections = SCORED_SECTION_SLOTS.filter(([group, slot]) => {
      const section = scoredSection(latest, group, slot);
      return section.summary && !isCompatibleVector(section.embedding, config.embeddingDimensions);
    });
    if (missingFacts.length === 0 && missingSections.length === 0) return;

    const vectors = await embedTexts([
      ...missingFacts.map((f) => f.content),
      ...missingSections.map(([group, slot]) => scoredSection(latest, group, slot).summary),
    ]);
    if (vectors.every((v) => v == null)) return; // 全部失败：等下次回填重试

    const vectorById = new Map<string, number[]>();
    const contentById = new Map<string, string>();
    missingFacts.forEach((f, i) => {
      if (vectors[i] != null) {
        vectorById.set(f.id, vectors[i]!);
        contentById.set(f.id, f.content);
      }
    });
    const sectionVectorBySlot = new Map<string, number[]>();
    const sectionSummaryBySlot = new Map<string, string>();
    missingSections.forEach(([group, slot], j) => {
      const vector = vectors[missingFacts.length + j];
      if (vector != null) {
        sectionVectorBySlot.set(`${group}.${slot}`, vector);
        sectionSummaryBySlot.set(`${group}.${slot}`, scoredSection(latest, group, slot).summary);
      }
    });

    // 锁内重读最新状态并重新执行合并：嵌入期间 updater 可能已落盘新内容，
    // 只合入「仍存在且 content / summary 未变」的条目，与 updater 的写互斥。
    await storage.update((fresh) => {
      let dirty = false;
      const next = { ...fresh };

      const mergedFacts = fresh.facts.map((f: Fact) => {
        const vector = vectorById.get(f.id);
        if (vector == null) return f;
        if (contentById.get(f.id) !== f.content) return f; // content 已变：旧向量作废
        return { ...f, embedding: vector };
      });
      if (mergedFacts.some((f, i) => f !== fresh.facts[i])) {
        next.facts = mergedFacts;
        dirty = true;
      }

      // section 合并守卫：槽位 summary 未变（相对嵌入时）、且仍未被 updater 补齐才写；
      // 整槽替换（不动 fresh 原对象，与 facts 侧同纪律）
      const sectionVectorFor = (slotKey: string, currentSummary: string): number[] | null => {
        const vector = sectionVectorBySlot.get(slotKey);
        if (vector == null) return null;
        if (sectionSummaryBySlot.get(slotKey) !== currentSummary) return null; // summary 已变
        return vector;
      };
      const topOfMindVec = sectionVectorFor('user.topOfMind', next.user.topOfMind.summary);
      if (topOfMindVec && !isCompatibleVector(next.user.topOfMind.embedding, topOfMindVec.length)) {
        next.user = {
          ...next.user,
          topOfMind: { ...next.user.topOfMind, embedding: topOfMindVec },
        };
        dirty = true;
      }
      const recentVec = sectionVectorFor('history.recentMonths', next.history.recentMonths.summary);
      if (recentVec && !isCompatibleVector(next.history.recentMonths.embedding, recentVec.length)) {
        next.history = {
          ...next.history,
          recentMonths: { ...next.history.recentMonths, embedding: recentVec },
        };
        dirty = true;
      }
      const earlierVec = sectionVectorFor(
        'history.earlierContext',
        next.history.earlierContext.summary,
      );
      if (
        earlierVec &&
        !isCompatibleVector(next.history.earlierContext.embedding, earlierVec.length)
      ) {
        next.history = {
          ...next.history,
          earlierContext: { ...next.history.earlierContext, embedding: earlierVec },
        };
        dirty = true;
      }
      const longTermVec = sectionVectorFor(
        'history.longTermBackground',
        next.history.longTermBackground.summary,
      );
      if (
        longTermVec &&
        !isCompatibleVector(next.history.longTermBackground.embedding, longTermVec.length)
      ) {
        next.history = {
          ...next.history,
          longTermBackground: { ...next.history.longTermBackground, embedding: longTermVec },
        };
        dirty = true;
      }

      return dirty ? next : fresh;
    }, scope);
  } catch (e) {
    if (!warnedBackfillFailure) {
      warnedBackfillFailure = true;
      console.warn('[memory/embeddings] backfill failed:', e);
    }
  } finally {
    backfillInFlight.delete(key);
  }
}

function createEmbeddingsInstance(): Embeddings | null {
  const factory = _factory;
  if (!factory) return null;
  try {
    return factory();
  } catch (e) {
    warnEmbedFailureOnce('factory', e);
    return null;
  }
}

function warnEmbedFailureOnce(stage: string, e: unknown): void {
  if (warnedEmbedFailure) return;
  warnedEmbedFailure = true;
  console.warn(`[memory/embeddings] ${stage} failed (falling back to lexical scoring):`, e);
}
