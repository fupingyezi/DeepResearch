/**
 * 记忆检索（词面打分 + 可选语义向量混合）
 *
 * 与「全量注入」互补的第二种记忆使用模式：按当前用户输入检索出相关度最高的
 * 少量 facts 与 section，用更小的 token 预算注入 system prompt。
 *
 * 打分模型：fact 得分 = 混合相关性 × 置信度加权，其中
 * - 词面分量：query token 重叠率（对「提到记忆中已有实体名」最有效）；
 * - 语义分量：query 向量与文本向量的余弦相似度（对同义改写有效），
 *   仅当文本有维度匹配的向量且余弦 ≥ 语义门槛时参与混合
 *   （未达标视为语义不相关，回落纯词面，防止弱相关噪声灌满 topK）。
 * facts 与 sections（topOfMind / history）走同一套混合打分核心（hybridScoreParts），
 * 同义改写在 section 选段同样能命中。
 * 无向量 / 无 Key / API 失败时 queryEmbedding 为 null，行为与纯词面完全一致。
 */

import { cosineSimilarity, isCompatibleVector } from './embeddings';
import type { Fact, FactCategory, MemoryData, SectionData } from './types';

export interface RetrievalOptions {
  /** 最多保留的 fact 条数（默认 8）。 */
  topK?: number;
  /** 保留 section 的最低得分（默认 0.05）。 */
  minScore?: number;
  /** query 的语义向量（buildMemoryContext 一次性向量化；null/缺省 = 纯词面）。 */
  queryEmbedding?: number[] | null;
  /** 混合分中余弦相似度权重，0..1（默认 0.7，与 MemoryConfig 默认一致）。 */
  hybridWeight?: number;
  /** 语义分量参与混合的余弦下限，0..1（默认 0.6，与 MemoryConfig 默认一致）。 */
  semanticMatchThreshold?: number;
}

const DEFAULT_TOP_K = 8;
const DEFAULT_MIN_SCORE = 0.05;
const DEFAULT_HYBRID_WEIGHT = 0.7;
/**
 * 语义分量参与混合的余弦下限。
 *
 * 依据对 embedding-3 的实测标定（中文短文本，1024 维）：
 * - 真相关：0.64 ~ 0.69（「他写服务端喜欢用什么编程语言？」↔「…TypeScript…后端服务开发」= 0.677；
 *   「他的猫叫什么名字？」↔「用户的猫叫豆豆」= 0.641）
 * - 无关基线明显更高：0.44 ~ 0.55（「今天天气不错适合出门散步」↔ 猫事实 = 0.550；
 *   「帮我写一个快速排序」↔ 两条事实 = 0.44/0.45）
 *
 * 即无关样本的余弦并不低（短文本共性拉高了基线），取 0.6 才能把 12 个正负样本全部判对；
 * 取更低值会把无关事实一并注入（噪声进 prompt），取更高值则漏掉真阳性。
 */
const SEMANTIC_MATCH_THRESHOLD = 0.6;

/** 中英停用词（只列高频虚词，避免把「的/了/the/a」当有效信号）。 */
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'have',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'were',
  'what',
  'which',
  'with',
  'you',
  'your',
  '的',
  '了',
  '和',
  '是',
  '在',
  '我',
  '有',
  '就',
  '不',
  '人',
  '都',
  '一',
  '上',
  '也',
  '很',
  '到',
  '说',
  '要',
  '去',
  '会',
  '着',
  '没有',
  '看',
  '好',
  '自',
  '这',
  '那',
  '吗',
  '呢',
  '吧',
  '请',
  '帮',
  '怎么',
  '什么',
  '如何',
]);

/**
 * 分词：latin 词（小写）+ CJK 单字与二元组（bigram）。
 *
 * CJK 加二元组是为了让「量子计算」这类复合词在只有部分重合时也能命中
 * （「量子」命中「量子计算」的 bigram 集合）。
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const tokens: string[] = [];
  const lower = text.toLowerCase();

  // latin 词
  for (const match of lower.matchAll(/[a-z0-9_]+/g)) {
    const word = match[0];
    if (word.length >= 2 && !STOP_WORDS.has(word)) tokens.push(word);
  }

  // CJK：单字 + 相邻二元组
  for (const match of lower.matchAll(/[一-鿿]+/g)) {
    const run = match[0];
    for (let i = 0; i < run.length; i++) {
      const ch = run[i];
      if (!STOP_WORDS.has(ch)) tokens.push(ch);
      if (i + 1 < run.length) tokens.push(run.slice(i, i + 2));
    }
  }

  return tokens;
}

/** 计算文本与 query token 集合的重叠率（|交集| / |query|）。 */
export function overlapRatio(text: string, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  const tokens = tokenize(text);
  if (tokens.length === 0) return 0;
  let hit = 0;
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (queryTokens.has(token)) hit++;
  }
  return hit / queryTokens.size;
}

/**
 * 混合打分上下文：facts 与 sections 共用同一套打分参数，
 * 两类打分口径不会漂移（含语义门槛与混合权重）。
 */
export interface ScoreContext {
  queryTokens: Set<string>;
  /** null/缺省 = 纯词面。 */
  queryEmbedding?: number[] | null;
  hybridWeight?: number;
  /** 语义分量参与混合的余弦下限，0..1（默认 0.6）。 */
  semanticMatchThreshold?: number;
}

/**
 * 混合相关度核心：词面重叠 + 过门槛的余弦加权混合。
 * 无向量 / 维度失效 / 余弦未达门槛时语义分量整体退出（开关而非衰减），
 * 退回纯词面——弱相关噪声不会借短文本高余弦基线混入。
 */
export function hybridScoreParts(
  text: string,
  embedding: number[] | undefined,
  ctx: ScoreContext,
): { lexical: number; cosine: number | null; semanticUsed: boolean; base: number } {
  const lexical = overlapRatio(text, ctx.queryTokens);
  const threshold = ctx.semanticMatchThreshold ?? SEMANTIC_MATCH_THRESHOLD;

  let cosine: number | null = null;
  let semanticUsed = false;
  if (ctx.queryEmbedding && isCompatibleVector(embedding, ctx.queryEmbedding.length)) {
    cosine = cosineSimilarity(embedding, ctx.queryEmbedding);
    semanticUsed = cosine >= threshold;
  }

  const w = ctx.hybridWeight ?? DEFAULT_HYBRID_WEIGHT;
  const base = semanticUsed && cosine != null ? w * cosine + (1 - w) * lexical : lexical;
  return { lexical, cosine, semanticUsed, base };
}

/**
 * fact 得分 = 混合相关性 × 置信度加权（0.5 + 0.5 × confidence）。
 * 置信度只做加权不做门槛：低置信但高度相关的 fact 仍可能入选。
 *
 * 混合相关性：fact 有维度匹配的向量且余弦过门槛时取
 * `w × 余弦 + (1-w) × 重叠率`（w = hybridWeight），否则退回纯重叠率——
 * 老数据（无向量）/ 维度失效 / 语义不相关都以词面分顶替，不被系统性压低。
 */
export function scoreFact(fact: Fact, ctx: ScoreContext): number {
  return factScoreParts(fact, ctx).score;
}

/** section 得分：无 confidence 概念，直接取混合相关度（与 facts 同一口径）。 */
export function scoreSection(section: SectionData, ctx: ScoreContext): number {
  return hybridScoreParts(section.summary ?? '', section.embedding, ctx).base;
}

/** fact 打分的分量明细（供预览/调试展示；打分口径与 scoreFact 同源，不会漂移）。 */
export interface FactScoreParts {
  /** 词面重叠率（0..1）。 */
  lexical: number;
  /** query 与该 fact 向量的余弦；无向量 / 维度不符 → null。 */
  cosine: number | null;
  /** 余弦是否达到阈值并实际参与混合。 */
  semanticUsed: boolean;
  /** 混合相关度 = w×余弦 + (1-w)×词面（未参与语义时 = 词面）。 */
  base: number;
  /** 最终得分 = base × (0.5 + 0.5×confidence)，与排序口径一致。 */
  score: number;
}

/**
 * 拆分打分的各个分量（scoreFact 内部即调用本函数）。
 * 单独导出是为了让「检索预览」能展示 词面 / 余弦 / 阈值 / 加权 每一步，
 * 同时保证与真实排序用的是同一套公式。
 */
export function factScoreParts(fact: Fact, ctx: ScoreContext): FactScoreParts {
  const confidence = Number.isFinite(fact.confidence)
    ? Math.max(0, Math.min(1, fact.confidence))
    : 0;
  const parts = hybridScoreParts(fact.content, fact.embedding, ctx);
  return { ...parts, score: parts.base * (0.5 + 0.5 * confidence) };
}

/** 检索预览：逐条 fact 的打分明细 + 是否真的被注入。 */
export interface FactScoreDetail extends FactScoreParts {
  id: string;
  content: string;
  category: FactCategory;
  confidence: number;
  /** 是否进入实际注入集合（由 retrieveMemory 的真实结果决定，非本函数自行判定）。 */
  picked: boolean;
}

/**
 * 逐条列出 fact 的打分明细（按得分降序），供预览接口 / 调试展示。
 *
 * `picked` **取自 retrieveMemory 的真实返回**，因此本函数不会与真实检索行为脱节：
 * 排序、minScore 过滤、topK 截断的口径都以实际检索为准。
 */
export function previewFactScores(
  data: MemoryData | null | undefined,
  query: string,
  options?: RetrievalOptions,
): FactScoreDetail[] {
  if (!data || !Array.isArray(data.facts)) return [];
  const ctx: ScoreContext = {
    queryTokens: new Set(tokenize(query)),
    queryEmbedding: options?.queryEmbedding ?? null,
    hybridWeight: options?.hybridWeight,
    semanticMatchThreshold: options?.semanticMatchThreshold,
  };

  const pickedIds = new Set(
    (
      retrieveMemory(data, query, {
        topK: options?.topK,
        minScore: options?.minScore,
        queryEmbedding: ctx.queryEmbedding,
        hybridWeight: ctx.hybridWeight,
        semanticMatchThreshold: ctx.semanticMatchThreshold,
      })?.facts ?? []
    ).map((f) => f.id),
  );

  return data.facts
    .map((fact) => ({
      id: fact.id,
      content: fact.content,
      category: fact.category,
      confidence: fact.confidence,
      ...factScoreParts(fact, ctx),
      picked: pickedIds.has(fact.id),
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * 预览用：模块内**不可配置**的两个门槛常量，便于解读打分明细。
 * （topK / hybridWeight 来自 MemoryConfig，真实值请从 getMemoryConfig() 取。）
 */
export function retrievalThresholds(): { semanticMatch: number; minScore: number } {
  return { semanticMatch: SEMANTIC_MATCH_THRESHOLD, minScore: DEFAULT_MIN_SCORE };
}

/**
 * 按 query 检索 memory，返回同构的 `MemoryData` 子集（可直接喂
 * `formatMemoryForInjection`）：
 * - facts：得分 > minScore 的条目按得分降序取 topK；
 * - user 段：workContext / personalContext 视为身份信息恒保留（通常很短），
 *   topOfMind 属时效内容，按 query 相关性取舍（混合打分，同义改写可命中）；
 * - history 段：三段各按相关性评分（混合打分），只保留得分最高且达标的一段。
 *
 * query 为空或全部落空时返回 null（调用方据此跳过注入，避免噪声）。
 */
export function retrieveMemory(
  data: MemoryData | null | undefined,
  query: string,
  options?: RetrievalOptions,
): MemoryData | null {
  if (!data) return null;

  const queryTokens = new Set(tokenize(query));
  // 纯图 / 纯 OCR 场景可能没有有效 token，但有语义向量时仍可检索
  if (queryTokens.size === 0 && !options?.queryEmbedding) return null;

  const topK = Math.max(1, options?.topK ?? DEFAULT_TOP_K);
  const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;
  const scoreCtx: ScoreContext = {
    queryTokens,
    queryEmbedding: options?.queryEmbedding ?? null,
    hybridWeight: options?.hybridWeight,
    semanticMatchThreshold: options?.semanticMatchThreshold,
  };

  const scoredFacts = (data.facts ?? [])
    .map((fact) => ({ fact, score: scoreFact(fact, scoreCtx) }))
    .filter((entry) => entry.score > minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const emptySection: SectionData = { summary: '', updatedAt: '' };
  const user = data.user ?? {
    workContext: emptySection,
    personalContext: emptySection,
    topOfMind: emptySection,
  };
  const history = data.history ?? {
    recentMonths: emptySection,
    earlierContext: emptySection,
    longTermBackground: emptySection,
  };

  // history 只保留最相关的一段
  const historyCandidates: Array<[keyof typeof history, SectionData]> = [
    ['recentMonths', history.recentMonths],
    ['earlierContext', history.earlierContext],
    ['longTermBackground', history.longTermBackground],
  ];
  let bestHistoryKey: keyof typeof history | null = null;
  let bestHistoryScore = 0;
  for (const [key, section] of historyCandidates) {
    if (!section?.summary) continue;
    const score = scoreSection(section, scoreCtx);
    if (score > bestHistoryScore) {
      bestHistoryScore = score;
      bestHistoryKey = key;
    }
  }
  const pickedHistory = {
    recentMonths: bestHistoryKey === 'recentMonths' ? history.recentMonths : emptySection,
    earlierContext: bestHistoryKey === 'earlierContext' ? history.earlierContext : emptySection,
    longTermBackground:
      bestHistoryKey === 'longTermBackground' ? history.longTermBackground : emptySection,
  };
  if (bestHistoryScore < minScore) {
    pickedHistory.recentMonths = emptySection;
    pickedHistory.earlierContext = emptySection;
    pickedHistory.longTermBackground = emptySection;
  }

  const hasFact = scoredFacts.length > 0;
  const hasUser = Boolean(user.workContext?.summary || user.personalContext?.summary);
  const hasTopOfMind =
    user.topOfMind?.summary != null && scoreSection(user.topOfMind, scoreCtx) >= minScore;
  const hasHistory = Boolean(
    pickedHistory.recentMonths.summary ||
    pickedHistory.earlierContext.summary ||
    pickedHistory.longTermBackground.summary,
  );

  if (!hasFact && !hasUser && !hasTopOfMind && !hasHistory) return null;

  return {
    version: data.version,
    lastUpdated: data.lastUpdated,
    user: {
      workContext: user.workContext,
      personalContext: user.personalContext,
      topOfMind: hasTopOfMind ? user.topOfMind : emptySection,
    },
    history: pickedHistory,
    facts: scoredFacts.map((entry) => entry.fact),
  };
}
