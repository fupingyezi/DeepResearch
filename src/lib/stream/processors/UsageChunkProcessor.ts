import type { ApiStreamChunk, ApiStreamUsageChunk } from "@/types/transform/stream";
import type { ChunkProcessor, ProcessContext } from "./ChunkProcessor";
import type { TokenPricing } from "../types";

export class UsageChunkProcessor implements ChunkProcessor {
  readonly type = "usage";
  private tokenPricing?: TokenPricing;

  constructor(tokenPricing?: TokenPricing) {
    this.tokenPricing = tokenPricing;
  }

  canProcess(data: any): boolean {
    return data.usage_metadata !== undefined;
  }

  process(data: any, context?: ProcessContext): ApiStreamChunk[] {
    try {
      if (!this.canProcess(data)) {
        return [];
      }

      const usage = data.usage_metadata;

      const chunk: ApiStreamUsageChunk = {
        type: "usage",
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cacheWriteTokens: usage.cache_write_tokens,
        cacheReadTokens: usage.cache_read_tokens,
        reasoningTokens: usage.reasoning_tokens,
        totalCost: this.calculateCost(usage),
      };

      return [chunk];
    } catch (error) {
      console.error("UsageChunkProcessor error:", error);
      return [];
    }
  }

  private calculateCost(usage: any): number | undefined {
    if (!this.tokenPricing) return undefined;

    const inputCost = (usage.input_tokens || 0) * this.tokenPricing.inputPrice;
    const outputCost = (usage.output_tokens || 0) * this.tokenPricing.outputPrice;

    return inputCost + outputCost;
  }
}
