import type { ApiStreamChunk, ApiStreamGroundingChunk, GroundingSource } from "@/types/transform/stream";
import type { ChunkProcessor, ProcessContext } from "./ChunkProcessor";

export class GroundingChunkProcessor implements ChunkProcessor {
  readonly type = "grounding";

  canProcess(data: any): boolean {
    return data.grounding_metadata?.sources !== undefined;
  }

  process(data: any, context?: ProcessContext): ApiStreamChunk[] {
    try {
      if (!this.canProcess(data)) {
        return [];
      }

      const sources = data.grounding_metadata.sources.map((source: any) => ({
        title: source.title,
        url: source.url,
        snippet: source.snippet,
      })) as GroundingSource[];

      const chunk: ApiStreamGroundingChunk = {
        type: "grounding",
        sources,
      };

      return [chunk];
    } catch (error) {
      console.error("GroundingChunkProcessor error:", error);
      return [];
    }
  }
}
