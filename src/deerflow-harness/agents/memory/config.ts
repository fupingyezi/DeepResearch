/**
 * Memory configuration。
 *
 * 单例模式：模块加载时初始化默认值；上层应用可调用 `setMemoryConfig` /
 * `loadMemoryConfigFromDict` 覆盖。
 */

export interface MemoryConfig {
  /** 总开关。 */
  enabled: boolean;
  /** debounce 等待秒数，1..300。 */
  debounceSeconds: number;
  /** 用于 memory 总结的 LLM 模型名（null=用默认）。 */
  modelName: string | null;
  /** 最多保留 fact 条数。 */
  maxFacts: number;
  /** 入库 fact 的最低 confidence 阈值。 */
  factConfidenceThreshold: number;
  /** 是否把 memory 注入到 system prompt。 */
  injectionEnabled: boolean;
  /** 注入 token 预算（tiktoken 计数）。 */
  maxInjectionTokens: number;
  /** 检索模式（memoryMode='retrieve'）保留的 fact 条数上限，1..50。 */
  retrieveTopK: number;
  /** 检索模式注入 token 预算，100..4000。 */
  retrieveMaxTokens: number;
  /**
   * 路 A（向量召回）的余弦门槛，0..1。
   * 标定依据见 retrieval.ts SEMANTIC_MATCH_THRESHOLD 注释：embedding-3 中文短文本
   * 无关基线 0.44~0.55、真相关 0.64~0.69，默认 0.6 落在两簇空隙。
   * 换 embedding 模型 / 语言后基线可能偏移，可经此调整。
   */
  semanticMatchThreshold: number;
  /** 是否启用 embedding 语义检索（工厂缺失 / 失败自动回落 lexical）。 */
  embeddingEnabled: boolean;
  /** 向量维度，256..2048（智谱 embedding-3 可配）。 */
  embeddingDimensions: number;
  /** 检索时（query 向量化成功后）是否异步回填缺失向量的旧 facts。 */
  embeddingBackfillEnabled: boolean;
  /** 是否启用 rerank 精排（工厂缺失 / API 失败自动回落 RRF 序）。 */
  rerankEnabled: boolean;
  /** 记忆更新 LLM 调用超时（ms）：挂起会永久占住队列的 processing 标记。 */
  updateTimeoutMs: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  debounceSeconds: 30,
  modelName: null,
  maxFacts: 100,
  factConfidenceThreshold: 0.7,
  injectionEnabled: true,
  maxInjectionTokens: 2000,
  retrieveTopK: 8,
  retrieveMaxTokens: 800,
  semanticMatchThreshold: 0.6,
  embeddingEnabled: true,
  embeddingDimensions: 1024,
  embeddingBackfillEnabled: true,
  rerankEnabled: true,
  updateTimeoutMs: 60000,
};

let _config: MemoryConfig = { ...DEFAULT_MEMORY_CONFIG };

export function getMemoryConfig(): MemoryConfig {
  return _config;
}

export function setMemoryConfig(config: MemoryConfig): void {
  _config = { ...config };
}

/** 从 dict 加载（部分字段可缺失，未提供则用默认）。 */
export function loadMemoryConfigFromDict(dict: Partial<Record<string, any>>): void {
  const out: MemoryConfig = { ...DEFAULT_MEMORY_CONFIG };
  const m = dict as Record<string, any>;

  if (typeof m.enabled === 'boolean') out.enabled = m.enabled;
  if (typeof m.debounce_seconds === 'number') out.debounceSeconds = m.debounce_seconds;
  if (typeof m.debounceSeconds === 'number') out.debounceSeconds = m.debounceSeconds;
  if (typeof m.model_name === 'string' || m.model_name === null) out.modelName = m.model_name;
  if (typeof m.modelName === 'string' || m.modelName === null) out.modelName = m.modelName;
  if (typeof m.max_facts === 'number') out.maxFacts = m.max_facts;
  if (typeof m.maxFacts === 'number') out.maxFacts = m.maxFacts;
  if (typeof m.fact_confidence_threshold === 'number') {
    out.factConfidenceThreshold = m.fact_confidence_threshold;
  }
  if (typeof m.factConfidenceThreshold === 'number') {
    out.factConfidenceThreshold = m.factConfidenceThreshold;
  }
  if (typeof m.injection_enabled === 'boolean') out.injectionEnabled = m.injection_enabled;
  if (typeof m.injectionEnabled === 'boolean') out.injectionEnabled = m.injectionEnabled;
  if (typeof m.max_injection_tokens === 'number') out.maxInjectionTokens = m.max_injection_tokens;
  if (typeof m.maxInjectionTokens === 'number') out.maxInjectionTokens = m.maxInjectionTokens;

  out.debounceSeconds = clamp(out.debounceSeconds, 1, 300);
  out.maxFacts = clamp(out.maxFacts, 10, 500);
  out.factConfidenceThreshold = clamp(out.factConfidenceThreshold, 0, 1);
  out.maxInjectionTokens = clamp(out.maxInjectionTokens, 100, 8000);
  if (typeof m.retrieve_top_k === 'number') out.retrieveTopK = m.retrieve_top_k;
  if (typeof m.retrieveTopK === 'number') out.retrieveTopK = m.retrieveTopK;
  if (typeof m.retrieve_max_tokens === 'number') out.retrieveMaxTokens = m.retrieve_max_tokens;
  if (typeof m.retrieveMaxTokens === 'number') out.retrieveMaxTokens = m.retrieveMaxTokens;
  if (typeof m.semantic_match_threshold === 'number') {
    out.semanticMatchThreshold = m.semantic_match_threshold;
  }
  if (typeof m.semanticMatchThreshold === 'number') {
    out.semanticMatchThreshold = m.semanticMatchThreshold;
  }
  out.retrieveTopK = clamp(out.retrieveTopK, 1, 50);
  out.retrieveMaxTokens = clamp(out.retrieveMaxTokens, 100, 4000);
  out.semanticMatchThreshold = clamp(out.semanticMatchThreshold, 0, 1);

  if (typeof m.embedding_enabled === 'boolean') out.embeddingEnabled = m.embedding_enabled;
  if (typeof m.embeddingEnabled === 'boolean') out.embeddingEnabled = m.embeddingEnabled;
  if (typeof m.embedding_dimensions === 'number') out.embeddingDimensions = m.embedding_dimensions;
  if (typeof m.embeddingDimensions === 'number') out.embeddingDimensions = m.embeddingDimensions;
  // dict 蛇形键 embedding_backfill_on_load 保留兼容（历史配置文件的键名）
  if (typeof m.embedding_backfill_on_load === 'boolean') {
    out.embeddingBackfillEnabled = m.embedding_backfill_on_load;
  }
  if (typeof m.embeddingBackfillEnabled === 'boolean') {
    out.embeddingBackfillEnabled = m.embeddingBackfillEnabled;
  }
  if (typeof m.rerank_enabled === 'boolean') out.rerankEnabled = m.rerank_enabled;
  if (typeof m.rerankEnabled === 'boolean') out.rerankEnabled = m.rerankEnabled;
  if (typeof m.update_timeout_ms === 'number') out.updateTimeoutMs = m.update_timeout_ms;
  if (typeof m.updateTimeoutMs === 'number') out.updateTimeoutMs = m.updateTimeoutMs;
  out.embeddingDimensions = clamp(out.embeddingDimensions, 256, 2048);
  out.updateTimeoutMs = clamp(out.updateTimeoutMs, 5000, 600000);

  _config = out;
}

function clamp(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}
