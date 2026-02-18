import type { ApiStream, ApiStreamChunk } from "@/types/transform/stream";
import type { ChunkProcessor } from "./processors/ChunkProcessor";
import type { StreamTransformerOptions, TransformContext } from "./types";
import { TextChunkProcessor } from "./processors/TextChunkProcessor";
import { ToolCallChunkProcessor } from "./processors/ToolCallChunkProcessor";
import { UsageChunkProcessor } from "./processors/UsageChunkProcessor";
import { ReasoningChunkProcessor } from "./processors/ReasoningChunkProcessor";
import { GroundingChunkProcessor } from "./processors/GroundingChunkProcessor";
import { UsageTracker } from "./trackers/UsageTracker";

export class StreamChunkTransformer {
  private options: StreamTransformerOptions;
  private processors: ChunkProcessor[];
  private usageTracker: UsageTracker;

  constructor(options?: StreamTransformerOptions) {
    this.options = {
      enableToolCalls: true,
      enableUsageTracking: true,
      enableReasoning: false,
      enableGrounding: false,
      streamMode: "default",
      ...options,
    };

    this.processors = [];
    this.usageTracker = new UsageTracker();

    this.initializeProcessors();
  }

  private initializeProcessors(): void {
    const streamMode = this.options.streamMode || "default";
    this.processors.push(new TextChunkProcessor(streamMode));

    if (this.options.enableToolCalls) {
      this.processors.push(new ToolCallChunkProcessor(streamMode));
    }

    if (this.options.enableUsageTracking) {
      this.processors.push(new UsageChunkProcessor(streamMode));
    }

    if (this.options.enableReasoning) {
      this.processors.push(new ReasoningChunkProcessor(streamMode));
    }

    if (this.options.enableGrounding) {
      this.processors.push(new GroundingChunkProcessor(streamMode));
    }
  }

  async *transformLangChainStream(
    stream: AsyncIterable<any>,
    context?: TransformContext,
  ): ApiStream {
    try {
      for await (const receivedMessage of stream) {
        console.log("Received message:", receivedMessage);

        try {
          const chunks = this.processMessage(receivedMessage, context);

          for (const chunk of chunks) {
            if (chunk.type === "usage") {
              this.usageTracker.track(chunk);
            }
            yield chunk;
          }
        } catch (error) {
          console.error("Message processing error:", error);
          continue;
        }
      }
    } catch (error: any) {
      console.error("Stream processing error:", error);
      yield {
        type: "error",
        error: error.name || "StreamError",
        message: error.message || "Stream processing failed",
      } as ApiStreamChunk;
    }
  }

  private processMessage(
    message: any,
    context?: TransformContext,
  ): ApiStreamChunk[] {
    const chunks: ApiStreamChunk[] = [];

    for (const processor of this.processors) {
      if (processor.canProcess(message)) {
        try {
          const processorChunks = processor.process(message, context);
          chunks.push(...processorChunks);
        } catch (error) {
          console.error(`Processor ${processor.type} failed:`, error);
        }
      }
    }

    return chunks;
  }

  registerProcessor(processor: ChunkProcessor): void {
    this.processors.push(processor);
  }

  unregisterProcessor(type: string): void {
    this.processors = this.processors.filter((p) => p.type !== type);
  }

  getUsageTracker(): UsageTracker {
    return this.usageTracker;
  }

  getProcessors(): ChunkProcessor[] {
    return this.processors;
  }
}
