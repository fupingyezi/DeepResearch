/**
 * LLM Module
 *
 * Unified interface for building LLM instances across different providers.
 * Supports OpenRouter, Alibaba Qwen, and iFlytek Spark.
 *
 * @module lib/llm
 */

export { buildLLM } from "./apiBuildHandler";
export type { Provider, LLMOptions, ProviderConfig } from "./types";
