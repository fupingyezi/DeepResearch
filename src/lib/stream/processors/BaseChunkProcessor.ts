import type { ChunkProcessor, ProcessContext } from "./ChunkProcessor";
import type { StreamMode } from "../types";

export abstract class BaseChunkProcesser implements ChunkProcessor {
  abstract readonly type: string;
  streamMode: StreamMode;

  constructor(streamMode: StreamMode = "default") {
    this.streamMode = streamMode;
  }

  abstract canProcess(data: any): boolean;

  abstract process(data: any, context?: ProcessContext): any[];

  protected extractByStreamMode(data: any): any {
    switch (this.streamMode) {
      case "updates":
        return (
          data?.model_request?.messages?.[0] ||
          data?.tools?.messages?.[0] ||
          data
        );
      case "messages":
        return data?.[0] || data;
      default:
        return data;
    }
  }

  protected getTextContent(data: any): string {
    const extracted = this.extractByStreamMode(data);
    console.log("extracted", extracted);
    return extracted?.content || extracted?.text || "";
  }
}
