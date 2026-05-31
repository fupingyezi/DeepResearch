/**
 * Memory configuration。
 *
 * 单例模式：模块加载时初始化默认值；上层应用可调用 `setMemoryConfig` /
 * `loadMemoryConfigFromDict` 覆盖。
 */

export interface MemoryConfig {
  /** 总开关。 */
  enabled: boolean;
  /**
   * 自定义存储路径。
   * - 空：使用默认 `{base_dir}/users/{user_id}/memory.json`（per-user）。
   * - 绝对路径：所有 user 共享该文件（opt-out per-user）。
   * - 相对路径：解析为 `{base_dir}/<relative>`。
   */
  storagePath: string;
  /** 存储后端类路径（保留字段，TS 端目前只用 File 后端）。 */
  storageClass: string;
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
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  storagePath: '',
  storageClass: 'deerflow.agents.memory.storage.FileMemoryStorage',
  debounceSeconds: 30,
  modelName: null,
  maxFacts: 100,
  factConfidenceThreshold: 0.7,
  injectionEnabled: true,
  maxInjectionTokens: 2000,
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
  if (typeof m.storage_path === 'string') out.storagePath = m.storage_path;
  if (typeof m.storagePath === 'string') out.storagePath = m.storagePath;
  if (typeof m.storage_class === 'string') out.storageClass = m.storage_class;
  if (typeof m.storageClass === 'string') out.storageClass = m.storageClass;
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

  _config = out;
}

function clamp(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}
