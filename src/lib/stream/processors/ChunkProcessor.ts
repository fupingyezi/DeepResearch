import type { ApiStreamChunk } from "@/types/transform/stream";
import type { StreamMode } from "../types";

export interface ProcessContext {
  sessionId?: string;
  metadata?: Record<string, any>;
  state?: Record<string, any>;
}

export interface ChunkProcessor {
  readonly type: string;
  streamMode: StreamMode;
  canProcess(data: any): boolean;
  process(data: any, context?: ProcessContext): ApiStreamChunk[];
}
