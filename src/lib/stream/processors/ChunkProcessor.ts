import type { ApiStreamChunk } from "@/types/transform/stream";

export interface ProcessContext {
  sessionId?: string;
  metadata?: Record<string, any>;
  state?: Record<string, any>;
}

export interface ChunkProcessor {
  readonly type: string;
  canProcess(data: any): boolean;
  process(data: any, context?: ProcessContext): ApiStreamChunk[];
}
