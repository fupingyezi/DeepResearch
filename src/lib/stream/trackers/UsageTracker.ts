import type { ApiStreamUsageChunk } from "@/types/transform/stream";

export class UsageTracker {
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCacheWriteTokens = 0;
  private totalCacheReadTokens = 0;
  private totalReasoningTokens = 0;

  track(usage: ApiStreamUsageChunk): void {
    this.totalInputTokens += usage.inputTokens;
    this.totalOutputTokens += usage.outputTokens;
    this.totalCacheWriteTokens += usage.cacheWriteTokens || 0;
    this.totalCacheReadTokens += usage.cacheReadTokens || 0;
    this.totalReasoningTokens += usage.reasoningTokens || 0;
  }

  getTotal(): ApiStreamUsageChunk {
    return {
      type: "usage",
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      cacheWriteTokens: this.totalCacheWriteTokens,
      cacheReadTokens: this.totalCacheReadTokens,
      reasoningTokens: this.totalReasoningTokens,
    };
  }

  reset(): void {
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCacheWriteTokens = 0;
    this.totalCacheReadTokens = 0;
    this.totalReasoningTokens = 0;
  }
}
