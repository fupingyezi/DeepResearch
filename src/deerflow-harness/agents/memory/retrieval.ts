/**
 * 记忆检索：RAG 管线（双路召回 → RRF 融合 → rerank 精排 → 组装）。
 *
 * 与「全量注入」互补的第二种记忆使用模式：按当前用户输入检索出相关度最高的
 * 少量 facts 与 section，用更小的 token 预算注入 system prompt。
 *
 * 生产链路只消费检索子集（picked）；打分明细（预览/调试展示）独立在
 * retrieval.preview.ts——管线在 `collectTrace` 时把中间产物快照（trace）
 * 交给它组装，预览与真实注入同一来源、不会漂移。
 *
 * 管线：
 * - 路 A 向量召回：pgvector 余弦 top-50（SQL 失败 / 无后端 → JS 线性扫描兜底）；
 *   余弦 ≥ 语义门槛才进 RRF；4 个召回 section 单独 JS 过门槛并入——pgvector 的
 *   top-50 可能全被 facts 占满，section 不能因此丢（只算 ≤4 次余弦，代价可忽略）；
 * - 路 B 词面召回：BM25（JS，语料 = facts + 4 召回 section，idf 查询时现算）top-50。
 *   idf 压掉「在/研究」这类语料高频词、tf 与文档长度归一化对长文不偏——精确术语
 *   （缩写 / 标识符）的命中比向量路更直接；与 obsidian-rag 的 FTS5 BM25 同语义
 *   （那里语料在 SQLite，这里 ≤104 篇全在内存，现算零成本）；
 * - RRF(k=60) 按**排名**融合——向量分与 BM25 分不同量纲，排名天然可比；
 * - 候选池宽 = max(topK, 20)（池窄时 4 个召回 section 会挤占 fact 名额、topK
 *   取不满；池只是候选空间，最终组装仍按 final 取 topK，注入条数不变）；
 * - rerank 精排池头 20 条，池尾接续倒数排名分（rank 从 20 起）；未注册 / 失败 → 状态切换告警 +
 *   保持 RRF 序（本项目惯例静默降级，与 obsidian-rag fail-fast 的刻意差异点）；
 * - 组装：final =（rerank ?? RRF）×（0.5 + 0.5×confidence）取 topK——rerank 只
 *   提供精排**顺序**（原始分压缩 0.99+ 量级无意义，转成与 RRF 同量纲的倒数
 *   排名分 1/(RRF_K+rank+1)，池头为精排名次、池尾为接续名次），两支可跨条目比较；
 *   workContext/personalContext 恒保留（身份信息）；history 三段留池内最优一段；
 *   topOfMind 进池才留。双路全空 → null → 不注入。
 *
 * rerank 原始分分布高度压缩（不相关也常 0.99+），只做相对排序；「全部落空」由
 * 双路召回皆空判定，不存在绝对分数阈值。BM25 分同理只做**同轮相对排序**
 * （idf 随语料变化，跨轮不可比）。
 */

import { cosineSimilarity, isCompatibleVector, RECALL_SECTION_SLOTS } from './embeddings';
import { memoryDegradeStats } from './stats';
import type { VectorSearchResult } from './storage';
import type { Fact, MemoryData, SectionData } from './types';

const RECALL_EACH = 50; // 双路召回各取 50（facts 上限 100，足够宽）
const RERANK_CANDIDATES = 20; // rerank 精排头宽，同时是候选池宽下限
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

/** latin 停用词（只列高频虚词，避免把「the/a」当有效信号）。
 *  CJK 不设停用词：BM25 的 idf 按语料现算，天然压掉全语料高频字；
 *  停用词表只拦单字、拦不住 bigram（「的」删了仍以「好的」这类二元组进索引）。 */
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
      tokens.push(ch);
      if (i + 1 < run.length) tokens.push(run.slice(i, i + 2));
    }
  }

  return tokens;
}

// ---- BM25（路 B 词面打分）----

const BM25_K1 = 1.5; // tf 饱和参数（标准值）
const BM25_B = 0.75; // 文档长度归一化强度（标准值）

/** 语料统计：df 按「每文档去重后是否含词」计，与标准 BM25 口径一致。 */
export interface Bm25Stats {
  docCount: number;
  avgDocLength: number;
  /** term → 含该词的文档数。 */
  docFreq: Map<string, number>;
}

export function buildBm25Stats(docs: string[][]): Bm25Stats {
  const docFreq = new Map<string, number>();
  let totalLength = 0;
  for (const tokens of docs) {
    totalLength += tokens.length;
    for (const term of new Set(tokens)) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }
  return {
    docCount: docs.length,
    avgDocLength: docs.length > 0 ? totalLength / docs.length : 0,
    docFreq,
  };
}

/**
 * BM25+ 打分：Σ_{t∈query} idf(t) × tf(t,d)×(k1+1) / (tf + k1×(1−b+b×dl/avgdl))。
 * idf 取 BM25+ 变体 ln(1+(N−df+0.5)/(df+0.5))——恒非负，语料内高频词 idf≈0 自然被压掉；
 * query 侧按唯一 term 求和（多轮拼接的词面 query 不会被未命中词稀释）。
 */
export function bm25Score(
  docTokens: string[],
  queryTokens: Set<string>,
  stats: Bm25Stats,
  k1 = BM25_K1,
  b = BM25_B,
): number {
  if (queryTokens.size === 0 || docTokens.length === 0 || stats.docCount === 0) return 0;
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  // avgdl = 0 只可能发生在全部文档为空时，此时任意 tf 均为 0，比值取 1 兜底即可
  const dlRatio = stats.avgDocLength > 0 ? docTokens.length / stats.avgDocLength : 1;
  let score = 0;
  for (const term of queryTokens) {
    const f = tf.get(term);
    if (!f) continue;
    const df = stats.docFreq.get(term) ?? 0;
    if (df === 0) continue; // tf>0 必然 df≥1，此处只防脏语料统计
    const idf = Math.log(1 + (stats.docCount - df + 0.5) / (df + 0.5));
    score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * dlRatio)));
  }
  return score;
}

// ---- 候选标识：`fact:<id>` / `section:<group>.<slot>`（与 pg-storage 的 ref_id 同口径）----
// 导出供 retrieval.preview.ts 组装明细时按同一口径取 ref。

export function factRef(id: string): string {
  return `fact:${id}`;
}

export function sectionRef(group: 'user' | 'history', slot: string): string {
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
function getSection(data: MemoryData, group: 'user' | 'history', slot: string): SectionData {
  const value = (data[group] as unknown as Record<string, SectionData>)[slot];
  return value ?? { summary: '', updatedAt: '' };
}

// ---- 召回 ----

export interface LexicalHit {
  ref: string;
  /** BM25 分（无上界，同轮内可比）。 */
  bm25: number;
}

/**
 * 全量语料词面打分（不截断）：召回截断与 trace 明细共用同一份分数。
 * 语料 = facts + 4 个召回 section（与向量路可召回集合一致），query 时现算
 * corpus 统计并逐篇 BM25 打分，> 0 者按分降序返回全量。
 * 多轮拼接的词面 query 会带出上轮实体（省略式提问「它呢？」命中），
 * BM25 按唯一 query term 求和、未命中词不计分，长 query 不稀释命中权重。
 */
function scoreAllLexical(data: MemoryData, queryTokens: Set<string>): LexicalHit[] {
  const docs: Array<{ ref: string; tokens: string[] }> = [];
  for (const f of data.facts ?? []) docs.push({ ref: factRef(f.id), tokens: tokenize(f.content) });
  for (const [group, slot] of RECALL_SECTION_SLOTS) {
    const section = getSection(data, group, slot);
    if (!section?.summary) continue;
    docs.push({ ref: sectionRef(group, slot), tokens: tokenize(section.summary) });
  }
  const stats = buildBm25Stats(docs.map((d) => d.tokens));
  return docs
    .map((d) => ({ ref: d.ref, bm25: bm25Score(d.tokens, queryTokens, stats) }))
    .filter((h) => h.bm25 > 0)
    .sort((a, b) => b.bm25 - a.bm25);
}

/** 路 B 词面召回：全量打分后取 top-N。 */
export function lexicalRecall(
  data: MemoryData,
  queryTokens: Set<string>,
  limit: number,
): LexicalHit[] {
  return scoreAllLexical(data, queryTokens).slice(0, limit);
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
  for (const [group, slot] of RECALL_SECTION_SLOTS) {
    const section = getSection(data, group, slot);
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

/** 候选池条目（导出供 trace 消费者取明细字段）。 */
export interface PoolEntry {
  ref: string;
  kind: 'fact' | 'section';
  /** 供 rerank 的正文（fact.content / section.summary）。 */
  text: string;
  rrf: number;
  /** 倒数排名分（1/(RRF_K+rank+1)，与 RRF 同量纲）：池头为精排名次、
   *  池尾为接续名次（rank 从 RERANK_CANDIDATES 起）；未参与精排 → null。
   *  provider 原始分高度压缩（不相关也 0.99+），量级不可比，只取它给出的顺序。 */
  rerank: number | null;
  /** provider 原始精排分（分布压缩，不参与 final）：精排排序依据，
   *  经 trace 透出给预览明细展示。 */
  rerankRaw: number | null;
  /** 组装排序分：final =（rerank ?? RRF）×（fact 再乘 confidence 权重），
   *  在 rerank 之后统一算好写回——topK 选择与 trace 明细读同一个值。 */
  final: number | null;
  fact?: Fact;
  group?: 'user' | 'history';
  slot?: string;
}

/** 由 RRF 融合结果解析出完整候选（ref 必须能回到 data 里的实体，否则防御性跳过）。 */
function buildCandidatePool(data: MemoryData, fused: RrfEntry[]): PoolEntry[] {
  const factById = new Map((data.facts ?? []).map((f) => [f.id, f]));
  const pool: PoolEntry[] = [];
  for (const { ref, rrf } of fused) {
    if (ref.startsWith('fact:')) {
      const fact = factById.get(ref.slice('fact:'.length));
      if (!fact) continue;
      pool.push({
        ref,
        kind: 'fact',
        text: fact.content,
        rrf,
        rerank: null,
        rerankRaw: null,
        final: null,
        fact,
      });
    } else {
      const parsed = parseSectionRef(ref);
      if (!parsed) continue;
      const section = getSection(data, parsed.group, parsed.slot);
      if (!section?.summary) continue;
      pool.push({
        ref,
        kind: 'section',
        text: section.summary,
        rrf,
        rerank: null,
        rerankRaw: null,
        final: null,
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
 * fact 组装：按 final 降序取 topK（final 在组装分步骤已写回池条目）。
 * 稳定排序保持池序：rerank 分压缩（0.99+ 并列常见）时以精排 / RRF 序兜底。
 */
function finalizeFacts(
  ranked: PoolEntry[],
  topK: number,
): { facts: Fact[]; pickedIds: Set<string> } {
  const picked = ranked
    .filter((e) => e.kind === 'fact' && e.fact)
    .sort((a, b) => (b.final ?? 0) - (a.final ?? 0))
    .slice(0, topK);
  const facts = picked.map((e) => e.fact!);
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

/**
 * 管线中间产物快照（仅 `collectTrace` 时返回，供预览明细组装——见
 * retrieval.preview.ts 的 buildRetrievalDetail）。字段全部取自管线过程值，
 * 明细层不做二次计算，保证「预览看到的」与「实际注入的」同一来源。
 */
export interface RetrieveTrace {
  /** 候选池条目（rerank 与 final 已写回；rerank 前池序即 RRF 序）。 */
  pool: PoolEntry[];
  /** 全量语料 BM25 分（含未进 top-50 召回者：明细显示真实分而非 0）。 */
  bm25ByRef: Map<string, number>;
  /** 向量路命中（ref → 余弦，≥ 门槛才收录）。 */
  vectorHits: Map<string, number>;
  /** 实际进入注入集合的 fact id。 */
  pickedFactIds: Set<string>;
  /** topOfMind 是否保留（进池）。 */
  keepTopOfMind: boolean;
  /** 保留的 history 段（池内秩最优一段；未命中 → null）。 */
  historySlot: 'recentMonths' | 'earlierContext' | 'longTermBackground' | null;
  /** RRF 融合后的候选池大小。 */
  poolSize: number;
  /** 本轮是否真的走了 rerank 精排（注册了且成功返回等长分数）。 */
  rerankUsed: boolean;
  /** 向量路来源：pg = pgvector；js = 线性扫描兜底（无后端 / SQL 失败）；null = 无向量。 */
  vectorLeg: 'pg' | 'js' | null;
}

/** 生产结果：picked 可直接喂 formatMemoryForInjection；trace 仅 collectTrace 时返回。 */
export interface RetrieveResult {
  picked: MemoryData;
  trace?: RetrieveTrace;
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
  /** 收集预览明细所需的中间产物快照（trace）；生产链路不需要，缺省关闭。 */
  collectTrace?: boolean;
}

let warnedVectorDegrade = false;
let warnedRerankDegrade = false;

function warnVectorDegradeOnce(e: unknown): void {
  memoryDegradeStats.vectorFallbacks += 1;
  // 健康→故障切换时打 warn，故障期内静默计数（持续降级看 stats）
  if (warnedVectorDegrade) return;
  warnedVectorDegrade = true;
  console.warn('[memory/retrieval] vector recall failed, falling back to JS scan:', e);
}

function warnRerankDegradeOnce(e: unknown): void {
  memoryDegradeStats.rerankFailures += 1;
  if (warnedRerankDegrade) return;
  warnedRerankDegrade = true;
  console.warn('[memory/retrieval] rerank failed, keeping RRF order:', e);
}

/** 对应链路恢复 → 故障标记复位，再故障会重新打 warn。 */
function markVectorRecallHealthy(): void {
  if (!warnedVectorDegrade) return;
  warnedVectorDegrade = false;
  console.info('[memory/retrieval] vector recall recovered (pgvector)');
}

function markRerankHealthy(): void {
  if (!warnedRerankDegrade) return;
  warnedRerankDegrade = false;
  console.info('[memory/retrieval] rerank recovered');
}

/** 仅供测试使用：重置降级告警标志。 */
export function resetMemoryRetrievalDegrades(): void {
  warnedVectorDegrade = false;
  warnedRerankDegrade = false;
}

/**
 * 按 query 检索 memory，返回子集（picked，可直接喂 formatMemoryForInjection）。
 * collectTrace 时附带预览明细所需的中间产物快照（trace，见 retrieval.preview.ts）。
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
    let hits: VectorSearchResult[] | null = null;
    if (options.vectorRecall) {
      try {
        hits = await options.vectorRecall(queryEmbedding, RECALL_EACH);
        markVectorRecallHealthy();
      } catch (e) {
        warnVectorDegradeOnce(e);
      }
    }
    // pg 召回成功才标 pg；未注册 / 抛错 / 无后端一律走 JS 扫描兜底
    if (hits) {
      vectorLeg = 'pg';
    } else {
      hits = vectorRecallJs(data, queryEmbedding, RECALL_EACH);
      vectorLeg = 'js';
    }
    for (const h of hits) {
      if (h.similarity >= threshold) vectorHits.set(vectorRef(h), h.similarity);
    }
    // 4 个召回 section 单独 JS 过门槛并入：pgvector 的 top-50 可能全被 facts 占满，
    // section 不能因此丢。JS 兜底路径里这些条目已含在 vectorRecallJs 结果中，
    // has 判定跳过、数值同源，不影响最终排名。
    for (const [group, slot] of RECALL_SECTION_SLOTS) {
      const section = getSection(data, group, slot);
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
  const allLexical = scoreAllLexical(data, queryTokens);
  const lexicalHits = allLexical.slice(0, RECALL_EACH);

  // ---- RRF 融合 → 候选池 ----
  // 路 A 按真实相似度重排（PG 结果已降序，JS 并入的 section 需归位）再进 RRF；
  // Map 插入序保证平分时路 A 条目在前（tie 稳定）。
  const routeA = [...vectorHits.entries()].sort((x, y) => y[1] - x[1]).map(([ref]) => ref);
  // 池宽与 topK 解耦、恒 ≥ RERANK_CANDIDATES：池宽 = topK（默认 8）时 4 个
  // 召回 section 会挤占 fact 名额、topK 取不满；池只是候选空间，组装仍按
  // final 取 topK，不改变注入条数
  const poolSize = Math.max(topK, RERANK_CANDIDATES);
  const fused = rrfFuse(
    routeA,
    lexicalHits.map((h) => h.ref),
    RRF_K,
    poolSize,
  );
  if (fused.length === 0) return null; // 双路全空 → 不注入

  const pool = buildCandidatePool(data, fused);

  // ---- rerank 精排池头，池尾接续倒数排名分 ----
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
      markRerankHealthy();
      head.forEach((e, i) => {
        e.rerankRaw = scores![i] ?? 0;
      });
      head.sort((x, y) => (y.rerankRaw ?? 0) - (x.rerankRaw ?? 0));
      // provider 精排分高度压缩（不相关也常 0.99+），量级信息不可比也不可信：
      // 只取它给出的**顺序**，转成与 RRF 同量纲的倒数排名分参与组装——
      // 精排的作用被还原为「重排」，final 的 rrf / rerank 两支才可跨条目比较
      head.forEach((e, i) => {
        e.rerank = 1 / (RRF_K + i + 1);
      });
      // 池尾接续名次分（rank = RERANK_CANDIDATES + i）：头 min 1/(RRF_K+20) >
      // 尾 max 1/(RRF_K+21)，边界单调——尾段若沿用 RRF 分（两路求和，最高
      // ~0.033），会反超被精排压低的后段池头，rerank 一开尾段反而窜前
      tail.forEach((e, i) => {
        e.rerank = 1 / (RRF_K + RERANK_CANDIDATES + i + 1);
      });
      ranked = [...head, ...tail];
    }
  }

  // ---- 组装分（单一出处）：final =（rerank ?? RRF）×（fact 再乘 confidence 权重）----
  // rerank 与 rrf 同为倒数排名量纲（见上），fact 与 section 条目之间直接可比；
  // 一次算好写回池条目：topK 选择与预览明细读同一个值，公式不会漂移
  for (const e of pool) {
    e.final = (e.rerank ?? e.rrf) * (e.kind === 'fact' && e.fact ? confidenceWeight(e.fact) : 1);
  }

  // ---- 组装 ----
  const { facts: pickedFacts, pickedIds } = finalizeFacts(ranked, topK);
  const { user, history, keepTopOfMind, historySlot } = pickSections(data, ranked);

  const picked: MemoryData = {
    version: data.version,
    lastUpdated: data.lastUpdated,
    user,
    history,
    facts: pickedFacts,
  };

  if (!options.collectTrace) return { picked };

  // 明细组装所需的中间产物快照（buildRetrievalDetail 消费）。全量词面分含
  // 未进 top-50 召回者——截断只作用于召回，明细若显示 0 会把「词面有分但
  // 排在 50 名外」误读成「词面完全不匹配」
  return {
    picked,
    trace: {
      pool,
      bm25ByRef: new Map(allLexical.map((h) => [h.ref, h.bm25])),
      vectorHits,
      pickedFactIds: pickedIds,
      keepTopOfMind,
      historySlot,
      poolSize: pool.length,
      rerankUsed,
      vectorLeg,
    },
  };
}
