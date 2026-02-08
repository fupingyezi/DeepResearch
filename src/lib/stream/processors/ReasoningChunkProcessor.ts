import type { 
  ApiStreamChunk, 
  ApiStreamReasoningChunk, 
  ApiStreamThinkingCompleteChunk 
} from "@/types/transform/stream";
import type { ChunkProcessor, ProcessContext } from "./ChunkProcessor";

export class ReasoningChunkProcessor implements ChunkProcessor {
  readonly type = "reasoning";

  canProcess(data: any): boolean {
    return data.reasoning !== undefined || data.thinking !== undefined || data.thinking_complete !== undefined;
  }

  process(data: any, context?: ProcessContext): ApiStreamChunk[] {
    try {
      const chunks: ApiStreamChunk[] = [];

      if (data.reasoning || data.thinking) {
        const reasoningChunk: ApiStreamReasoningChunk = {
          type: "reasoning",
          text: data.reasoning || data.thinking || "",
          signature: data.signature,
        };
        chunks.push(reasoningChunk);
      }

      if (data.thinking_complete) {
        const thinkingCompleteChunk: ApiStreamThinkingCompleteChunk = {
          type: "thinking_complete",
          signature: data.signature || "",
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
