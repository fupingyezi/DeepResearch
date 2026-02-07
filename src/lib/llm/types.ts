/**
 * LLM Provider Types and Interfaces
 *
 * This module defines the types and interfaces for the LLM API build handler.
 * It supports multiple LLM providers including OpenRouter, Qwen, and Spark.
 */

/**
 * Supported LLM providers
 * - openrouter: OpenAI-compatible API via OpenRouter
 * - qwen: Alibaba Qwen (通义千问)
 * - spark: iFlytek Spark (讯飞星火)
 */
export type Provider = "openrouter" | "qwen" | "spark";

/**
 * Options for configuring an LLM instance
 * These options can override the default provider configuration
 */
export interface LLMOptions {
  /** Model name to use (e.g., 'qwen-max', 'gpt-4-turbo-preview') */
  model?: string;

  /** Temperature for response randomness (0-1, lower is more deterministic) */
  temperature?: number;

  /** Maximum number of tokens in the response */
  maxTokens?: number;

  /** Enable streaming mode for responses */
  streaming?: boolean;

  /** Request timeout in milliseconds */
  timeout?: number;
}

/**
 * Internal configuration for a provider
 * Contains both authentication and default settings
 */
export interface ProviderConfig {
  /** API key for authentication */
  apiKey: string;

  /** Base URL for the API endpoint (optional, provider-specific) */
  baseURL?: string;

  /** Default model name for this provider */
  defaultModel: string;

  /** Default temperature setting */
  defaultTemperature: number;

  /** Default maximum tokens */
  defaultMaxTokens: number;

  /** Default timeout in milliseconds */
  defaultTimeout: number;
}
