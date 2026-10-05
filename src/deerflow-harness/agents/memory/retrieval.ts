/**
 * 记忆检索：RAG 管线（双路召回 → RRF 融合 → rerank 精排 → 组装）。
 *
 * 与「全量注入」互补的第二种记忆使用模式：按当前用户输入检索出相关度最高的
 * 少量 facts 与 section，用更小的 token 预算注入 system prompt。
 *
 * 管线：
 * - 路 A 向量召回：pgvector 余弦 top-50（SQL 失败 / 无后端 → JS 线性扫描兜底）；
 *   余弦 ≥ 语义门槛才进 RRF；4 个打分 section 单独 JS 过门槛并入——pgvector 的
 *   top-50 可能全被 facts 占满，section 不能因此丢（只算 ≤4 次余弦，代价可忽略）；
 * - 路 B 词面召回：query token 重叠率 > 0 的 facts + 4 section，top-50；
 * - RRF(k=60) 按**排名**融合——向量分与词面分不同量纲，排名天然可比；
 * - rerank 精排池头（≤20 条），池尾按 RRF 序衔接；未注册 / 失败 → warnOnce
 *   保持 RRF 序（本项目惯例静默降级，与 obsidian-rag fail-fast 的刻意差异点）；
 * - 组装：final =（rerank 分 or RRF 分）×（0.5 + 0.5×confidence）取 topK；
 *   workContext/personalContext 恒保留（身份信息）；history 三段留池内最优一段；
 *   topOfMind 进池才留。双路全空 → null → 不注入。
 *
 * rerank 分分布高度压缩（不相关也常 0.99+），只做相对排序；「全部落空」由
 * 双路召回皆空判定，不存在绝对分数阈值。
 */

import { cosineSimilarity, isCompatibleVector, SCORED_SECTION_SLOTS } from './embeddings';
import type { VectorSearchResult } from './storage';
import type { Fact, FactCategory, MemoryData, SectionData } from './types';

const RECALL_EACH = 50; // 双路召回各取 50（facts 上限 100，足够宽）
const RERANK_CANDIDATES = 20; // RRF 候选池宽 / rerank 精排宽度
const RRF_K = 60; // RRF 常数 k
const DEFAULT_TOP_K = 8;

/**
 * 路 A 召回门槛（模块兜底值，真实生效值经 RetrieveOptions 传入，
 * 上游取自 MemoryConfig.semanticMatchThreshold，默认同为 0.6）。
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

  // CJK：单字 + 相邻二元组。
  // 范围与 prompt.ts 的 CJK_CHAR_RE 保持一致（Extension A + 基本区 + 兼容区），
  // 否则这些字符在 token 预算里按 1 token 计、在词面匹配里却完全不参与。
  for (const match of lower.matchAll(/[㐀-䶿一-鿿豈-﫿]+/g)) {
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

// ---- 候选标识：`fact:<id>` / `section:<group>.<slot>`（与 pg-storage 的 ref_id 同口径）----

function factRef(id: string): string {
  return `fact:${id}`;
}

function sectionRef(group: 'user' | 'history', slot: string): string {
  return `section:${group}.${slot}`;
}

function parseSectionRef(ref: string): { group: 'user' | 'history'; slot: string } | null {
  if (!ref.startsWith('section:')) return null;
  const body = ref.slice('section:'.length);
  const dot = body.indexOf('.');
  if (dot <= 0) return null;
  const group = body.slice(0, dot);
  if (group !== 'user' && group !== 'history') return null;
  return { group, slot: body.slice(dot + 1) };
}

/** vectorSearch 结果的 ref 化（fact 用 id；section 的 refId 已是 `group.slot`）。 */
function vectorRef(hit: VectorSearchResult): string {
  return hit.kind === 'fact' ? factRef(hit.refId) : `section:${hit.refId}`;
}

/** 按 group/slot 取 section；UserSection/HistorySection 字面量 key 需经 unknown 中转索引。 */
function scoredSection(data: MemoryData, group: 'user' | 'history', slot: string): SectionData {
  const value = (data[group] as unknown as Record<string, SectionData>)[slot];
  return value ?? { summary: '', updatedAt: '' };
}

// ---- 召回 ----

export interface LexicalHit {
  ref: string;
  lexical: number;
}

/** 路 B 词面召回：重叠率 > 0 的 facts + 4 个打分 section，按重叠率降序取 top-N。 */
export function lexicalRecall(
  data: MemoryData,
  queryTokens: Set<string>,
  limit: number,
): LexicalHit[] {
  const hits: LexicalHit[] = [];
  for (const f of data.facts ?? []) {
    const lexical = overlapRatio(f.content, queryTokens);
    if (lexical > 0) hits.push({ ref: factRef(f.id), lexical });
  }
  for (const [group, slot] of SCORED_SECTION_SLOTS) {
    const section = scoredSection(data, group, slot);
    if (!section?.summary) continue;
    const lexical = overlapRatio(section.summary, queryTokens);
    if (lexical > 0) hits.push({ ref: sectionRef(group, slot), lexical });
  }
  hits.sort((a, b) => b.lexical - a.lexical);
  return hits.slice(0, limit);
}

/**
 * 路 A 的 JS 余弦扫描兜底（pgvector 不可用 / SQL 失败时与 pg 路径等价）。
 * 与 pg-storage.vectorSearch 同口径返回：fact refId = id、section refId = `group.slot`。
 */
export function vectorRecallJs(
  data: MemoryData,
  queryEmbedding: number[],
  limit: number,
): VectorSearchResult[] {
  const hits: VectorSearchResult[] = [];
  for (const f of data.facts ?? []) {
    if (!isCompatibleVector(f.embedding, queryEmbedding.length)) continue;
    hits.push({
      kind: 'fact',
      refId: f.id,
      similarity: cosineSimilarity(f.embedding!, queryEmbedding),
    });
  }
  for (const [group, slot] of SCORED_SECTION_SLOTS) {
    const section = scoredSection(data, group, slot);
    if (!section?.summary || !isCompatibleVector(section.embedding, queryEmbedding.length)) {
      continue;
    }
    hits.push({
      kind: 'section',
      refId: `${group}.${slot}`,
      similarity: cosineSimilarity(section.embedding!, queryEmbedding),
    });
  }
  hits.sort((a, b) => b.similarity - a.similarity);
  return hits.slice(0, limit);
}

// ---- RRF 融合 ----

export interface RrfEntry {
  ref: string;
  /** 1/(k+rank+1) 的跨路累加；重复命中两路会加分。 */
  rrf: number;
}

/**
 * RRF 融合：两路召回只取排名，按 1/(k+rank+1) 加分后降序取 top-N。
 * Map 插入序即路 A 先、路 B 后，配合稳定排序保证平分时路 A 条目在前（tie 稳定）。
 */
export function rrfFuse(
  routeA: string[],
  routeB: string[],
  k = RRF_K,
  poolSize = RERANK_CANDIDATES,
): RrfEntry[] {
  const score = new Map<string, number>();
  const bump = (refs: string[]) =>
    refs.forEach((ref, i) => score.set(ref, (score.get(ref) ?? 0) + 1 / (k + i + 1)));
  bump(routeA);
  bump(routeB);
  return [...score.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, poolSize)
    .map(([ref, rrf]) => ({ ref, rrf }));
}

// ---- 候选池 / 组装 ----

interface PoolEntry {
  ref: string;
  kind: 'fact' | 'section';
  /** 供 rerank 的正文（fact.content / section.summary）。 */
  text: string;
  rrf: number;
  rerank: number | null;
  fact?: Fact;
  group?: 'user' | 'history';
  slot?: string;
}

/** 由 RRF 融合结果解析出完整候选（ref 必须能回到 data 里的实体，否则防御性跳过）。 */
function buildCandidatePool(
  data: MemoryData,
  fused: RrfEntry[],
  vectorHits: Map<string, number>,
  lexicalByRef: Map<string, number>,
): PoolEntry[] {
  const factById = new Map((data.facts ?? []).map((f) => [f.id, f]));
  const pool: PoolEntry[] = [];
  for (const { ref, rrf } of fused) {
    if (ref.startsWith('fact:')) {
      const fact = factById.get(ref.slice('fact:'.length));
      if (!fact) continue;
      pool.push({ ref, kind: 'fact', text: fact.content, rrf, rerank: null, fact });
    } else {
      const parsed = parseSectionRef(ref);
      if (!parsed) continue;
      const section = scoredSection(data, parsed.group, parsed.slot);
      if (!section?.summary) continue;
      pool.push({
        ref,
        kind: 'section',
        text: section.summary,
        rrf,
        rerank: null,
        group: parsed.group,
        slot: parsed.slot,
      });
    }
  }
  return pool;
}

function confidenceWeight(fact: Fact): number {
  const c = Number.isFinite(fact.confidence) ? Math.max(0, Math.min(1, fact.confidence)) : 0;
  return 0.5 + 0.5 * c;
}

/**
 * fact 组装：final =（rerank 分 or RRF 分）×（0.5 + 0.5×confidence），降序取 topK。
 * 稳定排序保持池序：rerank 分压缩（0.99+ 并列常见）时以精排 / RRF 序兜底。
 */
function finalizeFacts(
  ranked: PoolEntry[],
  topK: number,
): { facts: Fact[]; pickedIds: Set<string> } {
  const weighted = ranked
    .filter((e) => e.kind === 'fact' && e.fact)
    .map((e) => ({ fact: e.fact!, final: (e.rerank ?? e.rrf) * confidenceWeight(e.fact!) }));
  weighted.sort((a, b) => b.final - a.final);
  const facts = weighted.slice(0, topK).map((w) => w.fact);
  return { facts, pickedIds: new Set(facts.map((f) => f.id)) };
}

/** section 组装：workContext/personalContext 恒保留；topOfMind 进池才留；
 *  history 三段留 ranked 序（池内秩）最靠前的一段。 */
function pickSections(
  data: MemoryData,
  ranked: PoolEntry[],
): {
  user: MemoryData['user'];
  history: MemoryData['history'];
  keepTopOfMind: boolean;
  historySlot: 'recentMonths' | 'earlierContext' | 'longTermBackground' | null;
} {
  const empty: SectionData = { summary: '', updatedAt: '' };
  const user = data.user ?? { workContext: empty, personalContext: empty, topOfMind: empty };
  const history = data.history ?? {
    recentMonths: empty,
    earlierContext: empty,
    longTermBackground: empty,
  };

  const topOfMindRef = sectionRef('user', 'topOfMind');
  let keepTopOfMind = false;
  let historySlot: 'recentMonths' | 'earlierContext' | 'longTermBackground' | null = null;
  for (const e of ranked) {
    if (e.kind !== 'section') continue;
    if (e.ref === topOfMindRef) {
      keepTopOfMind = true;
    } else if (e.group === 'history' && historySlot == null) {
      historySlot = e.slot as 'recentMonths' | 'earlierContext' | 'longTermBackground';
    }
  }

  return {
    user: {
      workContext: user.workContext,
      personalContext: user.personalContext,
      topOfMind: keepTopOfMind ? user.topOfMind : empty,
    },
    history: {
      recentMonths: historySlot === 'recentMonths' ? history.recentMonths : empty,
      earlierContext: historySlot === 'earlierContext' ? history.earlierContext : empty,
      longTermBackground: historySlot === 'longTermBackground' ? history.longTermBackground : empty,
    },
    keepTopOfMind,
    historySlot,
  };
}

// ---- 明细（预览/调试展示用；数据全部取自管线真实过程，不存在二次重算）----

export interface FactScoreDetail {
  id: string;
  content: string;
  category: FactCategory;
  confidence: number;
  /** 词面重叠率（0..1）。 */
  lexical: number;
  /** 向量路余弦；无向量 / 维度不符 / 未过门槛 → null。 */
  cosine: number | null;
  /** 是否由向量路召回（余弦 ≥ 门槛）。 */
  inVectorLeg: boolean;
  /** RRF 融合分；未进候选池 → null。 */
  rrf: number | null;
  /** rerank 分；未精排 / 精排失败 → null。 */
  rerank: number | null;
  /** 组装排序分 =（rerank 分 or RRF 分）×（0.5 + 0.5×confidence）；未进池 → null。 */
  final: number | null;
  /** 是否进入实际注入集合。 */
  picked: boolean;
}

export interface SectionScoreDetail {
  /** `user.topOfMind` / `history.recentMonths` 等。 */
  ref: string;
  group: 'user' | 'history';
  slot: string;
  summary: string;
  lexical: number;
  cosine: number | null;
  inVectorLeg: boolean;
  rrf: number | null;
  rerank: number | null;
  /** 池内秩来源分（rerank 分 or RRF 分）；未进池 → null。 */
  final: number | null;
  picked: boolean;
}

export interface RetrieveResult {
  picked: MemoryData;
  /** 全部 fact 的明细（含未入选者），按 final 降序。 */
  facts: FactScoreDetail[];
  /** 4 个打分 section 的明细。 */
  sections: SectionScoreDetail[];
  /** RRF 融合后的候选池大小。 */
  poolSize: number;
  /** 本轮是否真的走了 rerank 精排（注册了且成功返回等长分数）。 */
  rerankUsed: boolean;
  /** 向量路来源：pg = pgvector；js = 线性扫描兜底（无后端 / SQL 失败）；null = 无向量。 */
  vectorLeg: 'pg' | 'js' | null;
}

export interface RetrieveOptions {
  /** 最多保留的 fact 条数（默认 8）。 */
  topK?: number;
  /** query 的语义向量（null/缺省 = 纯词面）。 */
  queryEmbedding?: number[] | null;
  /** 路 A 召回门槛（默认 0.6，与 MemoryConfig 默认一致）。 */
  semanticMatchThreshold?: number;
  /** 向量路召回（pgvector <=>）；null/缺省 = JS 扫描。抛错由管线捕获并回落 JS 扫描。 */
  vectorRecall?: ((queryVector: number[], limit: number) => Promise<VectorSearchResult[]>) | null;
  /** rerank 精排；返回 null = 保持 RRF 序（rerankWithFallback 即此语义）。 */
  rerank?: ((query: string, docs: string[]) => Promise<number[] | null>) | null;
  /** rerank 用的单句 query（拼串会稀释语义）；缺省 = query。 */
  rerankQuery?: string;
}

let warnedVectorDegrade = false;
let warnedRerankDegrade = false;

function warnVectorDegradeOnce(e: unknown): void {
  if (warnedVectorDegrade) return;
  warnedVectorDegrade = true;
  console.warn('[memory/retrieval] vector recall failed, falling back to JS scan:', e);
}

function warnRerankDegradeOnce(e: unknown): void {
  if (warnedRerankDegrade) return;
  warnedRerankDegrade = true;
  console.warn('[memory/retrieval] rerank failed, keeping RRF order:', e);
}

/**
 * 按 query 检索 memory，返回子集与全程明细。子集可直接喂 formatMemoryForInjection。
 * query 为空且无向量、或双路召回全空时返回 null（调用方据此跳过注入，避免噪声）。
 */
export async function retrieveMemory(
  data: MemoryData | null | undefined,
  query: string,
  options: RetrieveOptions = {},
): Promise<RetrieveResult | null> {
  if (!data) return null;

  const queryTokens = new Set(tokenize(query));
  const queryEmbedding = options.queryEmbedding ?? null;
  // 纯图 / 纯 OCR 场景可能没有有效 token，但有语义向量时仍可检索
  if (queryTokens.size === 0 && !queryEmbedding) return null;

  const topK = Math.max(1, options.topK ?? DEFAULT_TOP_K);
  const threshold = options.semanticMatchThreshold ?? SEMANTIC_MATCH_THRESHOLD;

  // ---- 路 A：向量召回（pgvector 或 JS 扫描）----
  let vectorLeg: 'pg' | 'js' | null = null;
  const vectorHits = new Map<string, number>(); // ref → 相似度（≥ 门槛才收录）
  if (queryEmbedding) {
    vectorLeg = options.vectorRecall ? 'pg' : 'js';
    let hits: VectorSearchResult[] | null = null;
    if (options.vectorRecall) {
      try {
        hits = await options.vectorRecall(queryEmbedding, RECALL_EACH);
      } catch (e) {
        warnVectorDegradeOnce(e);
      }
    }
    if (!hits) {
      hits = vectorRecallJs(data, queryEmbedding, RECALL_EACH);
      vectorLeg = 'js';
    }
    for (const h of hits) {
      if (h.similarity >= threshold) vectorHits.set(vectorRef(h), h.similarity);
    }
    // 4 个打分 section 单独 JS 过门槛并入：pgvector 的 top-50 可能全被 facts 占满，
    // section 不能因此丢。JS 兜底路径里这些条目已含在 vectorRecallJs 结果中，
    // has 判定跳过、数值同源，不影响最终排名。
    for (const [group, slot] of SCORED_SECTION_SLOTS) {
      const section = scoredSection(data, group, slot);
      if (!section?.summary || !isCompatibleVector(section.embedding, queryEmbedding.length)) {
        continue;
      }
      const cosine = cosineSimilarity(section.embedding!, queryEmbedding);
      if (cosine >= threshold && !vectorHits.has(sectionRef(group, slot))) {
        vectorHits.set(sectionRef(group, slot), cosine);
      }
    }
  }

  // ---- 路 B：词面召回 ----
  const lexicalHits = lexicalRecall(data, queryTokens, RECALL_EACH);
  const lexicalByRef = new Map(lexicalHits.map((h) => [h.ref, h.lexical]));

  // ---- RRF 融合 → 候选池 ----
  // 路 A 按真实相似度重排（PG 结果已降序，JS 并入的 section 需归位）再进 RRF；
  // Map 插入序保证平分时路 A 条目在前（tie 稳定）。
  const routeA = [...vectorHits.entries()].sort((x, y) => y[1] - x[1]).map(([ref]) => ref);
  const poolSize = options.rerank ? Math.max(topK, RERANK_CANDIDATES) : topK;
  const fused = rrfFuse(
    routeA,
    lexicalHits.map((h) => h.ref),
    RRF_K,
    poolSize,
  );
  if (fused.length === 0) return null; // 双路全空 → 不注入

  const pool = buildCandidatePool(data, fused, vectorHits, lexicalByRef);

  // ---- rerank 精排池头，池尾按 RRF 序衔接 ----
  let rerankUsed = false;
  let ranked = pool;
  if (options.rerank && pool.length > 1) {
    const head = pool.slice(0, RERANK_CANDIDATES);
    const tail = pool.slice(RERANK_CANDIDATES);
    let scores: number[] | null = null;
    try {
      scores = await options.rerank(
        options.rerankQuery ?? query,
        head.map((e) => e.text),
      );
    } catch (e) {
      warnRerankDegradeOnce(e);
    }
    if (scores) {
      rerankUsed = true;
      head.forEach((e, i) => {
        e.rerank = scores![i] ?? 0;
      });
      head.sort((x, y) => (y.rerank ?? 0) - (x.rerank ?? 0));
      ranked = [...head, ...tail];
    }
  }

  // ---- 组装 ----
  const { facts: pickedFacts, pickedIds } = finalizeFacts(ranked, topK);
  const { user, history, keepTopOfMind, historySlot } = pickSections(data, ranked);

  const poolByRef = new Map(pool.map((e) => [e.ref, e]));
  const picked: MemoryData = {
    version: data.version,
    lastUpdated: data.lastUpdated,
    user,
    history,
    facts: pickedFacts,
  };

  const factsDetail: FactScoreDetail[] = (data.facts ?? [])
    .map((f) => {
      const ref = factRef(f.id);
      const entry = poolByRef.get(ref);
      return {
        id: f.id,
        content: f.content,
        category: f.category,
        confidence: f.confidence,
        lexical: lexicalByRef.get(ref) ?? 0,
        cosine: vectorHits.get(ref) ?? null,
        inVectorLeg: vectorHits.has(ref),
        rrf: entry?.rrf ?? null,
        rerank: entry?.rerank ?? null,
        final: entry ? (entry.rerank ?? entry.rrf) * confidenceWeight(f) : null,
        picked: pickedIds.has(f.id),
      };
    })
    .sort((a, b) => (b.final ?? -Infinity) - (a.final ?? -Infinity));

  const sectionsDetail: SectionScoreDetail[] = SCORED_SECTION_SLOTS.map(([group, slot]) => {
    const section = scoredSection(data, group, slot);
    const ref = sectionRef(group, slot);
    const entry = poolByRef.get(ref);
    return {
      ref,
      group,
      slot,
      summary: section.summary ?? '',
      lexical: lexicalByRef.get(ref) ?? 0,
      cosine: vectorHits.get(ref) ?? null,
      inVectorLeg: vectorHits.has(ref),
      rrf: entry?.rrf ?? null,
      rerank: entry?.rerank ?? null,
      final: entry ? (entry.rerank ?? entry.rrf) : null,
      picked: group === 'user' ? keepTopOfMind : historySlot === slot,
    };
  });

  return {
    picked,
    facts: factsDetail,
    sections: sectionsDetail,
    poolSize: pool.length,
    rerankUsed,
    vectorLeg,
  };
}
