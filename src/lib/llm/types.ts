/**
 * Supported LLM providers
 * - openrouter: OpenAI-compatible API via OpenRouter
 * - qwen: Alibaba Qwen (通义千问)
 * - spark: iFlytek Spark (讯飞星火)
 */
export type Provider = "openrouter" | "qwen" | "spark";

export interface LLMOptions {
  /** 自选模型名，如qwen-max, qwen-plus */
  model?: string;
  /** 模型温度，控制输出随机性，0~1 */
  temperature?: number;
  /** 最大tokens */
  maxTokens?: number;
  /** 是否采用流式响应 */
  streaming?: boolean;
  /** 最大响应时间 */
  timeout?: number;
}

export interface ProviderConfig {
  /** 个人apiKey */
  apiKey: string;
  /** 请求Url */
  baseURL?: string;
  /** 默认选用模型 */
  defaultModel: string;
  /** 默认模型温度 */
  defaultTemperature: number;
  /** 默认最大tokens */
  defaultMaxTokens: number;
  /** 默认最大响应时间 */
  defaultTimeout: number;
}
