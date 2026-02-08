import type {
  ApiStreamChunk,
  ApiStreamToolCallChunk,
  ApiStreamToolCallStartChunk,
  ApiStreamToolCallDeltaChunk,
  ApiStreamToolCallEndChunk,
} from "@/types/transform/stream";
import type { ChunkProcessor, ProcessContext } from "./ChunkProcessor";
import { ToolCallTracker } from "../trackers/ToolCallTracker";

export interface ToolCallState {
  id: string;
  name: string;
  arguments: string;
  status: "pending" | "streaming" | "complete";
  startTime: number;
}

export class ToolCallChunkProcessor implements ChunkProcessor {
  readonly type = "tool_call";
  private toolCallTracker: ToolCallTracker;

  constructor() {
    this.toolCallTracker = new ToolCallTracker();
  }

  canProcess(data: any): boolean {
    return (
      data.tool_calls &&
      Array.isArray(data.tool_calls) &&
      data.tool_calls.length > 0
    );
  }

  process(data: any, context?: ProcessContext): ApiStreamChunk[] {
    try {
      if (!this.canProcess(data)) {
        return [];
      }

      const chunks: ApiStreamChunk[] = [];

      for (const toolCall of data.tool_calls) {
        if (!toolCall.id || !toolCall.name) {
          continue;
        }

        if (!this.toolCallTracker.isActive(toolCall.id)) {
          // 新的工具调用
          chunks.push(this.createStartChunk(toolCall));
          this.toolCallTracker.startCall(toolCall.id, toolCall.name);
        }

        // 处理参数
        if (toolCall.args) {
          const argsString =
            typeof toolCall.args === "string"
              ? toolCall.args
              : JSON.stringify(toolCall.args);
          chunks.push(...this.createDeltaChunks(toolCall.id, argsString));
          this.toolCallTracker.updateCall(toolCall.id, argsString);
        }

        // 检查是否完成
        if (data.finish_reason) {
          chunks.push(this.createEndChunk(toolCall.id));
          chunks.push(this.createCompleteChunk(toolCall));
          this.toolCallTracker.completeCall(toolCall.id);
        }
      }

      return chunks;
    } catch (error) {
      console.error("ToolCallChunkProcessor error:", error);
      return [];
    }
  }

  private createStartChunk(toolCall: any): ApiStreamToolCallStartChunk {
    return {
      type: "tool_call_start",
      id: toolCall.id,
      name: toolCall.name,
    };
  }

  private createDeltaChunks(
    id: string,
    args: string,
  ): ApiStreamToolCallDeltaChunk[] {
    return [
      {
        type: "tool_call_delta",
        id,
        delta: args,
      },
    ];
  }

  private createEndChunk(id: string): ApiStreamToolCallEndChunk {
    return {
      type: "tool_call_end",
      id,
    };
  }

  private createCompleteChunk(toolCall: any): ApiStreamToolCallChunk {
    const argsString =
      typeof toolCall.args === "string"
        ? toolCall.args
        : JSON.stringify(toolCall.args);

    return {
      type: "tool_call",
      id: toolCall.id,
      name: toolCall.name,
      arguments: argsString,
    };
  }
}
