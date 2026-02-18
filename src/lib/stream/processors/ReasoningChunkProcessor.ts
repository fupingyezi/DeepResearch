import type {
  ApiStreamChunk,
  ApiStreamReasoningChunk,
  ApiStreamThinkingCompleteChunk,
} from "@/types/transform/stream";
import type { ProcessContext } from "./ChunkProcessor";
import { BaseChunkProcesser } from "./BaseChunkProcessor";
import type { StreamMode } from "../types";

export class ReasoningChunkProcessor extends BaseChunkProcesser {
  readonly type = "reasoning";

  constructor(streamMode: StreamMode = "default") {
    super(streamMode);
  }

  canProcess(data: any): boolean {
    return (
      data.reasoning !== undefined ||
      data.thinking !== undefined ||
      data.thinking_complete !== undefined
    );
  }

  process(data: any, context?: ProcessContext): ApiStreamChunk[] {
    try {
      const chunks: ApiStreamChunk[] = [];
      const extracted = this.extractByStreamMode(data);

      if (extracted.reasoning || extracted.thinking) {
        const reasoningChunk: ApiStreamReasoningChunk = {
          type: "reasoning",
          text: extracted.reasoning || extracted.thinking || "",
          signature: extracted.signature,
        };
        chunks.push(reasoningChunk);
      }

      if (extracted.thinking_complete) {
        const thinkingCompleteChunk: ApiStreamThinkingCompleteChunk = {
          type: "thinking_complete",
          signature: extracted.signature || "",
        };
        chunks.push(thinkingCompleteChunk);
      }

      return chunks;
    } catch (error) {
      console.error("ReasoningChunkProcessor error:", error);
      return [];
    }
  }
}
