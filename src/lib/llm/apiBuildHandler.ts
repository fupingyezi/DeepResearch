/**
 * LLM API Build Handler
 *
 * This module provides a unified interface for building LLM instances
 * across different providers (OpenRouter, Qwen, Spark).
 *
 * @example
 * ```typescript
 * // Basic usage
 * const model = buildLLM('qwen');
 *
 * // With streaming
 * const streamingModel = buildLLM('qwen', { streaming: true });
 *
 * // With custom configuration
 * const customModel = buildLLM('qwen', {
 *   model: 'qwen-turbo',
 *   temperature: 0.5,
 *   maxTokens: 4000
 * });
 * ```
 */

import { ChatOpenAI } from "@langchain/openai";
import { ChatAlibabaTongyi } from "@langchain/community/chat_models/alibaba_tongyi";
import { Provider, LLMOptions, ProviderConfig } from "./types";

/**
 * Default configurations for each provider
 * These can be overridden using the options parameter in buildLLM
 */
const PROVIDER_CONFIGS: Record<
  Provider,
  Omit<ProviderConfig, "apiKey" | "baseURL">
> = {
  openrouter: {
    defaultModel: "openai/gpt-4-turbo-preview",
    defaultTemperature: 0.7,
    defaultMaxTokens: 2000,
    defaultTimeout: 15000,
  },
  qwen: {
    defaultModel: "qwen-max",
    defaultTemperature: 0.3,
    defaultMaxTokens: 2000,
    defaultTimeout: 15000,
  },
  spark: {
    defaultModel: "spark-v3.5",
    defaultTemperature: 0.3,
    defaultMaxTokens: 2000,
    defaultTimeout: 15000,
  },
};

/**
 * Get the complete configuration for a provider
 * Reads API keys and base URLs from environment variables
 *
 * @param provider - The provider to get configuration for
 * @returns Complete provider configuration including API key and base URL
 * @throws Error if required environment variables are missing
 */
function getProviderConfig(provider: Provider): ProviderConfig {
  const baseConfig = PROVIDER_CONFIGS[provider];

  switch (provider) {
    case "openrouter": {
      const openrouterKey = process.env.OPENAI_API_KEY;
      if (!openrouterKey) {
        throw new Error("OPENAI_API_KEY is not set in environment variables");
      }
      return { ...baseConfig, apiKey: openrouterKey };
    }

    case "qwen": {
      const qwenKey = process.env.OPENAI_QWEN_API_KEY;
      const qwenBaseURL = process.env.OPENAI_QWEN_BASE_URL;
      if (!qwenKey || !qwenBaseURL) {
        throw new Error(
          "OPENAI_QWEN_API_KEY or OPENAI_QWEN_BASE_URL is not set in environment variables",
        );
      }
      return { ...baseConfig, apiKey: qwenKey, baseURL: qwenBaseURL };
    }

    case "spark": {
      const sparkKey = process.env.OPENAI_SPARK_API_KEY;
      const sparkBaseURL = process.env.OPENAI_SPARK_BASE_URL;
      if (!sparkKey || !sparkBaseURL) {
        throw new Error(
          "OPENAI_SPARK_API_KEY or OPENAI_SPARK_BASE_URL is not set in environment variables",
        );
      }
      return { ...baseConfig, apiKey: sparkKey, baseURL: sparkBaseURL };
    }

    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(`Unsupported provider: ${exhaustiveCheck}`);
    }
  }
}

/**
 * Build a ChatOpenAI instance for the specified provider
 *
 * This is the main entry point for creating LLM instances.
 * It handles provider-specific configuration and allows customization via options.
 *
 * @param provider - The LLM provider to use ('openrouter', 'qwen', or 'spark')
 * @param options - Optional configuration overrides
 * @returns Configured ChatOpenAI instance ready to use
 * @throws Error if provider is unsupported or required environment variables are missing
 *
 * @example
 * ```typescript
 * // Create a basic Qwen instance
 * const model = buildLLM('qwen');
 *
 * // Create a streaming instance
 * const streamModel = buildLLM('qwen', { streaming: true });
 *
 * // Create with custom settings
 * const customModel = buildLLM('qwen', {
 *   model: 'qwen-turbo',
 *   temperature: 0.5,
 *   maxTokens: 4000,
 *   timeout: 30000
 * });
 * ```
 */
export function buildLLM(provider: Provider, options?: LLMOptions): ChatOpenAI {
  const config = getProviderConfig(provider);

  return new ChatOpenAI({
    model: options?.model ?? config.defaultModel,
    apiKey: config.apiKey,
    configuration: config.baseURL ? { baseURL: config.baseURL } : undefined,
    maxTokens: options?.maxTokens ?? config.defaultMaxTokens,
    temperature: options?.temperature ?? config.defaultTemperature,
    streaming: options?.streaming,
    timeout: options?.timeout ?? config.defaultTimeout,
  });
}
