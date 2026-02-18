import type {
  ApiStreamChunk,
  ApiStreamUsageChunk,
} from "@/types/transform/stream";
import type { ProcessContext } from "./ChunkProcessor";
import type { TokenPricing, StreamMode } from "../types";
import { BaseChunkProcesser } from "./BaseChunkProcessor";

export class UsageChunkProcessor extends BaseChunkProcesser {
  readonly type = "usage";
  private tokenPricing?: TokenPricing;

  constructor(streamMode: StreamMode = "default", tokenPricing?: TokenPricing) {
    super(streamMode);
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

      const extracted = this.extractByStreamMode(data);
      const usage = extracted.usage_metadata;

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
    const outputCost =
      (usage.output_tokens || 0) * this.tokenPricing.outputPrice;

    return inputCost + outputCost;
  }
}
