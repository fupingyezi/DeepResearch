export type StreamMode = "default" | "updates" | "messages";

export interface StreamTransformerOptions {
  enableToolCalls?: boolean;
  enableUsageTracking?: boolean;
  enableReasoning?: boolean;
  enableGrounding?: boolean;
  streamMode?: StreamMode;
}

export interface TransformContext {
  sessionId?: string;
  streamMode?: StreamMode;
  metadata?: Record<string, any>;
  state?: Record<string, any>;
}

export interface TokenPricing {
  inputPrice: number;
  outputPrice: number;
}
