import type {
  ApiStreamChunk,
  ApiStreamTextChunk,
} from "@/types/transform/stream";
import type { ProcessContext } from "./ChunkProcessor";
import { BaseChunkProcesser } from "./BaseChunkProcessor";
import type { StreamMode } from "../types";

export class TextChunkProcessor extends BaseChunkProcesser {
  readonly type = "text";

  constructor(streamMode: StreamMode = "default") {
    super(streamMode);
  }

  canProcess(data: any): boolean {
    switch (this.streamMode) {
      case "updates":
        return data.model_request?.messages?.[0]?.content?.length > 0;
      case "messages":
        return (
          (typeof data?.[0]?.content === "string" &&
            data?.[0].content.length > 0) ||
          (typeof data?.content === "string" && data?.content.length > 0)
        );
      default:
        return (
          (typeof data?.[0]?.content === "string" &&
            data?.[0].content.length > 0) ||
          (typeof data?.content === "string" && data?.content.length > 0)
        );
    }
  }

  process(data: any, context?: ProcessContext): ApiStreamChunk[] {
    try {
      if (!this.canProcess(data)) {
        return [];
      }

      const text = this.getTextContent(data);
      console.log("text", text);

      if (!text || text.length === 0) {
        return [];
      }

      const chunk: ApiStreamTextChunk = {
        type: "text",
        text,
      };

      return [chunk];
    } catch (error) {
      console.error("TextChunkProcessor error:", error);
      return [];
    }
  }
}
