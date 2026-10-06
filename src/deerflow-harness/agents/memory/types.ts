/**
 * Memory data schema
 *
 * 以 JSON 结构持久化（PG jsonb 列）。所有时间戳为 ISO-8601 + `Z` 后缀（UTC）。
 */

export type FactCategory =
  | 'preference'
  | 'knowledge'
  | 'context'
  | 'behavior'
  | 'goal'
  | 'correction';

export interface SectionData {
  summary: string;
  /** ISO-8601 with `Z` suffix; 空字符串表示 "从未更新过"。 */
  updatedAt: string;
  /**
   * 语义向量。仅参与检索召回的 section 生成（topOfMind 与 history 三段）；
   * 恒保留的 workContext/personalContext 不进召回、不存向量。
   * 旧数据缺失；summary 改写后旧向量随整槽替换丢弃，由写侧重嵌或回填补齐。
   */
  embedding?: number[];
}

export interface UserSection {
  workContext: SectionData;
  personalContext: SectionData;
  topOfMind: SectionData;
}

export interface HistorySection {
  recentMonths: SectionData;
  earlierContext: SectionData;
  longTermBackground: SectionData;
}

export interface Fact {
  /** "fact_<8hex>" */
  id: string;
  content: string;
  category: FactCategory;
  /** 0..1 */
  confidence: number;
  /** ISO-8601 + Z */
  createdAt: string;
  /** thread_id 或 "manual" / "unknown" */
  source: string;
  /** 仅 category==='correction' 时可能存在。 */
  sourceError?: string;
  /**
   * 语义向量（智谱 embedding-3；维度见 MemoryConfig.embeddingDimensions）。
   * 旧数据缺失此字段；维度变更后旧向量视为失效，由回填重算。
   */
  embedding?: number[];
}

export interface MemoryData {
  version: '1.0';
  /** ISO-8601 + Z；save() 时刷新。 */
  lastUpdated: string;
  user: UserSection;
  history: HistorySection;
  facts: Fact[];
}

/** 当前 UTC ISO-8601（带 Z 后缀） */
export function utcNowIsoZ(): string {
  // toISOString() 已经是 ISO + Z 后缀。
  return new Date().toISOString();
}

/** 创建空 memory 结构。 */
export function createEmptyMemory(): MemoryData {
  const now = utcNowIsoZ();
  return {
    version: '1.0',
    lastUpdated: now,
    user: {
      workContext: { summary: '', updatedAt: '' },
      personalContext: { summary: '', updatedAt: '' },
      topOfMind: { summary: '', updatedAt: '' },
    },
    history: {
      recentMonths: { summary: '', updatedAt: '' },
      earlierContext: { summary: '', updatedAt: '' },
      longTermBackground: { summary: '', updatedAt: '' },
    },
    facts: [],
  };
}

/** Agent 名校验，避免路径穿越 */
export const AGENT_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function validateAgentName(agentName: string): void {
  if (!agentName) throw new Error('Agent name must be a non-empty string.');
  if (!AGENT_NAME_PATTERN.test(agentName)) {
    throw new Error(
      `Invalid agent name ${JSON.stringify(agentName)}: names must match ${AGENT_NAME_PATTERN}`,
    );
  }
}

/**
 * 把持久层读出的 JSON 合并到空 schema，保证下游字段安全（防御旧数据缺字段 /
 * 结构漂移）。facts 的非法 embedding（非数组 / 含非有限数）剥除，避免污染检索侧；
 * 维度不匹配的合法向量保留，由检索 / 回填按 config 维度判定失效并重算。
 */
export function mergeWithEmpty(parsed: unknown): MemoryData {
  const empty = createEmptyMemory();
  const p = (parsed ?? {}) as {
    lastUpdated?: unknown;
    user?: { workContext?: unknown; personalContext?: unknown; topOfMind?: unknown };
    history?: { recentMonths?: unknown; earlierContext?: unknown; longTermBackground?: unknown };
    facts?: unknown;
  };
  return {
    version: '1.0',
    lastUpdated: typeof p.lastUpdated === 'string' ? p.lastUpdated : empty.lastUpdated,
    user: {
      workContext: mergeSection(p.user?.workContext, empty.user.workContext),
      personalContext: mergeSection(p.user?.personalContext, empty.user.personalContext),
      topOfMind: mergeSection(p.user?.topOfMind, empty.user.topOfMind),
    },
    history: {
      recentMonths: mergeSection(p.history?.recentMonths, empty.history.recentMonths),
      earlierContext: mergeSection(p.history?.earlierContext, empty.history.earlierContext),
      longTermBackground: mergeSection(
        p.history?.longTermBackground,
        empty.history.longTermBackground,
      ),
    },
    facts: Array.isArray(p.facts)
      ? p.facts.filter((f) => f && typeof f === 'object').map((f) => sanitizeLoadedFact(f as Fact))
      : [],
  };
}

function sanitizeLoadedFact(f: Fact): Fact {
  if (f.embedding != null) {
    const v: unknown = f.embedding;
    const ok = Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x));
    if (!ok) {
      const rest = { ...f };
      delete rest.embedding;
      return rest;
    }
  }
  return f;
}

/**
 * section 合并：保留 summary/updatedAt 与合法的 embedding 向量。
 * 向量口径与 sanitizeLoadedFact 一致——非数组 / 含非有限数剥除；维度不符的
 * 合法向量保留，由检索 / 回填按 config 维度判定失效并重算。
 */
function mergeSection(s: unknown, dft: SectionData): SectionData {
  if (!s || typeof s !== 'object') return { ...dft };
  const src = s as Partial<SectionData>;
  const out: SectionData = {
    summary: typeof src.summary === 'string' ? src.summary : dft.summary,
    updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : dft.updatedAt,
  };
  if (
    Array.isArray(src.embedding) &&
    src.embedding.every((x: unknown) => typeof x === 'number' && Number.isFinite(x))
  ) {
    out.embedding = src.embedding as number[];
  }
  return out;
}
