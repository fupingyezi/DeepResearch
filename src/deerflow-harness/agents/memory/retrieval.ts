/**
 * 记忆检索（轻量关键词打分，零外部依赖）
 *
 * 与「全量注入」互补的第二种记忆使用模式：按当前用户输入检索出相关度最高的
 * 少量 facts 与 section，用更小的 token 预算注入 system prompt。
 *
 * 定位说明：这是**词面**相关性（词重叠 + 置信度加权），不是语义检索
 * （无 embedding / 向量库）。词面信号在「用户提到记忆中已有的实体名」这类
 * 场景最有效，对同义改写无能为力；因此检索模式只作为可选模式，默认仍是
 * 全量注入（inject）。
 */

import type { Fact, MemoryData, SectionData } from './types';

export interface RetrievalOptions {
  /** 最多保留的 fact 条数（默认 8）。 */
  topK?: number;
  /** 保留 section 的最低得分（默认 0.05）。 */
  minScore?: number;
}

const DEFAULT_TOP_K = 8;
const DEFAULT_MIN_SCORE = 0.05;

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
 * fact 得分 = 重叠率 × 置信度加权（0.5 + 0.5 × confidence）。
 * 置信度只做加权不做门槛：低置信但高度相关的 fact 仍可能入选。
 */
export function scoreFact(fact: Fact, queryTokens: Set<string>): number {
  const confidence = Number.isFinite(fact.confidence)
    ? Math.max(0, Math.min(1, fact.confidence))
    : 0;
  return overlapRatio(fact.content, queryTokens) * (0.5 + 0.5 * confidence);
}

/**
 * 按 query 检索 memory，返回同构的 `MemoryData` 子集（可直接喂
 * `formatMemoryForInjection`）：
 * - facts：得分 > minScore 的条目按得分降序取 topK；
 * - user 段：workContext / personalContext 视为身份信息恒保留（通常很短），
 *   topOfMind 属时效内容，按 query 相关性取舍；
 * - history 段：三段各按相关性评分，只保留得分最高且达标的一段。
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
  if (queryTokens.size === 0) return null;

  const topK = Math.max(1, options?.topK ?? DEFAULT_TOP_K);
  const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;

  const scoredFacts = (data.facts ?? [])
    .map((fact) => ({ fact, score: scoreFact(fact, queryTokens) }))
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
    const score = overlapRatio(section.summary, queryTokens);
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
  const hasTopOfMind = overlapRatio(user.topOfMind?.summary ?? '', queryTokens) >= minScore;
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
