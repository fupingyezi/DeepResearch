import type { ApiStreamChunk, ApiStreamTextChunk } from "@/types/transform/stream";
import type { ChunkProcessor, ProcessContext } from "./ChunkProcessor";

export class TextChunkProcessor implements ChunkProcessor {
  readonly type = "text";

  canProcess(data: any): boolean {
    return typeof data.content === "string" && data.content.length > 0;
  }

  process(data: any, context?: ProcessContext): ApiStreamChunk[] {
    try {
      if (!this.canProcess(data)) {
        return [];
      }

      const chunk: ApiStreamTextChunk = {
        type: "text",
        text: data.content,
      };

      return [chunk];
    } catch (error) {
      console.error("TextChunkProcessor error:", error);
      return [];
    }
  }
}
