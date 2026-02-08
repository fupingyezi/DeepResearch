export interface StreamTransformerOptions {
  enableToolCalls?: boolean;
  enableUsageTracking?: boolean;
  enableReasoning?: boolean;
  enableGrounding?: boolean;
}

export interface TransformContext {
  sessionId?: string;
  metadata?: Record<string, any>;
  state?: Record<string, any>;
}

export interface TokenPricing {
  inputPrice: number;
  outputPrice: number;
}
