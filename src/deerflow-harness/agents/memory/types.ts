/**
 * Memory data schema —— 与 Python 端 `agents/memory/storage.py::create_empty_memory` 完全对齐。
 *
 * 文件以 JSON 形式落盘。所有时间戳为 ISO-8601 + `Z` 后缀（UTC）。
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
}

export interface MemoryData {
  version: '1.0';
  /** ISO-8601 + Z；save() 时刷新。 */
  lastUpdated: string;
  user: UserSection;
  history: HistorySection;
  facts: Fact[];
}

/** 当前 UTC ISO-8601（带 Z 后缀），与 Python `utc_now_iso_z` 对齐。 */
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

/** Agent 名校验，避免路径穿越；与 Python AGENT_NAME_PATTERN 一致。 */
export const AGENT_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function validateAgentName(agentName: string): void {
  if (!agentName) throw new Error('Agent name must be a non-empty string.');
  if (!AGENT_NAME_PATTERN.test(agentName)) {
    throw new Error(
      `Invalid agent name ${JSON.stringify(agentName)}: names must match ${AGENT_NAME_PATTERN}`,
    );
  }
}
