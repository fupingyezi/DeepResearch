/**
 * Memory embeddings（智谱 embedding-3 语义检索基础设施）
 *
 * 设计要点：
 * - 工厂注入：app 层（threads/_service.ts）注册具体的 Embeddings 构造器，
 *   未注册 / 构造失败 / API 失败时所有出口静默降级（返回 null / 稀疏数组），
 *   **绝不抛出** —— 对应决策「无向量 / 无 Key / API 失败自动回落关键词检索」。
 * - 智谱 embedding-3 单请求最多 64 条文本：embedTexts 手动按批切片，
 *   不依赖 OpenAIEmbeddings 自带 batchSize（后端无关、便于 mock 测试）。
 * - 旧数据回填：backfillFactEmbeddings 补齐缺失 / 维度不匹配的 fact 向量，
 *   进程内 per-storage-key 去重；嵌入完成后重新 reload 再合并保存，只补
 *   「仍存在且 content 未变」的 fact，尽量避开与 LLM updater 的并发写互踩。
 */

import type { Embeddings } from '@langchain/core/embeddings';

import { getMemoryConfig } from './config';
import { getMemoryStorage } from './storage';
import type { Fact } from './types';

export type MemoryEmbeddingsFactory = () => Embeddings | null;

let _factory: MemoryEmbeddingsFactory | null = null;
let warnedEmbedFailure = false;
let warnedBackfillFailure = false;

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
}

/** 智谱 embedding-3 单请求输入条数上限。 */
export const EMBEDDING_BATCH_LIMIT = 64;

/** 单条文本向量化；工厂缺失 / 失败 / 空文本 → null（调用方回落 lexical）。 */
export async function embedQuery(text: string): Promise<number[] | null> {
  if (!text.trim()) return null;
  const embeddings = createEmbeddingsInstance();
  if (!embeddings) return null;
  try {
    return await embeddings.embedQuery(text);
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
        out[i + j] = vectors[j] ?? null;
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
 * 回填旧数据：为缺失 / 维度不匹配的 facts 补齐向量并落盘。
 * 检索侧命中后 fire-and-forget 调用，失败静默（warn 一次）。
 *
 * 并发语义：嵌入期间 updater 可能落盘新内容，故 save 前重新 reload 并只合并
 * 「仍存在且 content 未变」的 fact；残余竞态窗口由 FileMemoryStorage 原子写
 * （tmp+rename）保证文件不损坏，由 updater 下一轮重写兜底收敛。
 */
export async function backfillFactEmbeddings(opts: {
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
    const missing = latest.facts.filter(
      (f) => !isCompatibleVector(f.embedding, config.embeddingDimensions),
    );
    if (missing.length === 0) return;

    const vectors = await embedTexts(missing.map((f) => f.content));
    if (vectors.every((v) => v == null)) return; // 全部失败：等下次回填重试

    // save 前重新读最新数据合并，避免覆盖嵌入期间 updater 的并发写入
    const toSave = await storage.reload(scope);
    const vectorById = new Map<string, number[]>();
    const contentById = new Map<string, string>();
    missing.forEach((f, i) => {
      if (vectors[i] != null) {
        vectorById.set(f.id, vectors[i]!);
        contentById.set(f.id, f.content);
      }
    });

    const mergedFacts = toSave.facts.map((f: Fact) => {
      const vector = vectorById.get(f.id);
      if (vector == null) return f;
      if (contentById.get(f.id) !== f.content) return f; // content 已变：旧向量作废
      return { ...f, embedding: vector };
    });
    if (mergedFacts.some((f, i) => f !== toSave.facts[i])) {
      await storage.save({ ...toSave, facts: mergedFacts }, scope);
    }
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
