/**
 * @deprecated 请使用 AgentEventStream（来自 @/types/agentEvent）替代。
 * 此类型保留以支持 v1 路由的渐进式迁移。
 *
 * 当前仍有以下文件引用此模块：
 * - src/lib/stream/StreamChunkTransformer.ts
 * - src/lib/stream/trackers/UsageTracker.ts
 * - src/lib/stream/processors/UsageChunkProcessor.ts
 * - src/lib/stream/processors/GroundingChunkProcessor.ts
 * - src/lib/stream/processors/TextChunkProcessor.ts
 * - src/lib/stream/processors/ReasoningChunkProcessor.ts
 * - src/lib/stream/processors/ChunkProcessor.ts
 * - src/lib/stream/processors/ToolCallChunkProcessor.ts
 */
export type ApiStream = AsyncGenerator<ApiStreamChunk>;

/**
 * @deprecated 请使用 AgentEvent（来自 @/types/agentEvent）替代。
 * 此类型保留以支持 v1 路由的渐进式迁移。
 */
export type ApiStreamChunk =
  | ApiStreamTextChunk
  | ApiStreamUsageChunk
  | ApiStreamReasoningChunk
  | ApiStreamThinkingCompleteChunk
  | ApiStreamGroundingChunk
  | ApiStreamToolCallChunk
  | ApiStreamToolCallStartChunk
  | ApiStreamToolCallDeltaChunk
  | ApiStreamToolCallEndChunk
  | ApiStreamToolCallPartialChunk
  | ApiStreamError
  | ApiStreamStateChunk;

export interface ApiStreamStateChunk {
  type: "state";
  state: any;
}

export interface ApiStreamError {
  type: "error";
  error: string;
  message: string;
}

export interface ApiStreamTextChunk {
  type: "text";
  text: string;
}

export interface ApiStreamReasoningChunk {
  type: "reasoning";
  text: string;

  signature?: string;
}

export interface ApiStreamThinkingCompleteChunk {
  type: "thinking_complete";
  signature: string;
}

export interface ApiStreamUsageChunk {
  type: "usage";
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
  totalCost?: number;
}

export interface ApiStreamGroundingChunk {
  type: "grounding";
  sources: GroundingSource[];
}

export interface ApiStreamToolCallChunk {
  type: "tool_call";
  id: string;
  name: string;
  arguments: string;
}

export interface ApiStreamToolCallStartChunk {
  type: "tool_call_start";
  id: string;
  name: string;
}

export interface ApiStreamToolCallDeltaChunk {
  type: "tool_call_delta";
  id: string;
  delta: string;
}

export interface ApiStreamToolCallEndChunk {
  type: "tool_call_end";
  id: string;
}

export interface ApiStreamToolCallPartialChunk {
  type: "tool_call_partial";
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface GroundingSource {
  title: string;
  url: string;
  snippet?: string;
}
