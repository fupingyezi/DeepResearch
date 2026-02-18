import type {
  ApiStreamChunk,
  ApiStreamGroundingChunk,
  GroundingSource,
} from "@/types/transform/stream";
import type { ProcessContext } from "./ChunkProcessor";
import { BaseChunkProcesser } from "./BaseChunkProcessor";
import type { StreamMode } from "../types";

export class GroundingChunkProcessor extends BaseChunkProcesser {
  readonly type = "grounding";

  constructor(streamMode: StreamMode = "default") {
    super(streamMode);
  }

  canProcess(data: any): boolean {
    return data.grounding_metadata?.sources !== undefined;
  }

  process(data: any, context?: ProcessContext): ApiStreamChunk[] {
    try {
      if (!this.canProcess(data)) {
        return [];
      }

      const extracted = this.extractByStreamMode(data);
      const sources = extracted.grounding_metadata.sources.map(
        (source: any) => ({
          title: source.title,
          url: source.url,
          snippet: source.snippet,
        }),
      ) as GroundingSource[];

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
