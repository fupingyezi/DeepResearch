import { LLMOptions } from "@/lib";
import { ApiStream } from "@/types/transform/stream";
import { StreamChunkTransformer } from "@/lib/stream";

/**
 * Agent配置接口
 */
export interface AgentConfig extends LLMOptions {
  systemPrompt: string;
  tools?: any[];
  checkpointer?: any;
}

/**
 * Agent响应接口
 */
export interface AgentResponse {
  messages: any[];
  [key: string]: any;
}

export interface BaseAgentHandler {
  createMessage(
    systemPrompt: string,
    messages: any[],
    metadata?: { [key: string]: any },
  ): ApiStream;
  buildAgent(): void | Promise<void>;
  getConfig(): AgentConfig;
}

export abstract class BaseAgentServer implements BaseAgentHandler {
  private config: AgentConfig;
  protected transformer: StreamChunkTransformer;

  constructor(config: AgentConfig) {
    this.config = config;
    this.transformer = new StreamChunkTransformer({
      enableToolCalls: true,
      enableUsageTracking: true,
      enableReasoning: false,
      enableGrounding: false,
    });
  }

  abstract createMessage(
    systemPrompt: string,
    messages: any[],
    metadata?: { [key: string]: any },
  ): ApiStream;

  abstract buildAgent(): void | Promise<void>;

  getConfig(): AgentConfig {
    return { ...this.config };
  }

  protected getTransformer(): StreamChunkTransformer {
    return this.transformer;
  }
}
