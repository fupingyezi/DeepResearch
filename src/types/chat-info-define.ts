import type { UUIDTypes } from 'uuid';
import type { UploadedFileInfo } from '@/store/file-upload-store';

export type UploadedFileStatus = 'pending' | 'parsing' | 'success' | 'failed';

export interface UploadedFile {
  id: string;
  file: File;
  parsedStatus: UploadedFileStatus;
  sizeBytes?: number;
  error?: string;
}

/**
 * chat 调用入口携带的「已上传文件引用」最小集合。
 *
 * 仅暴露 fileId + mimeType：fileId 用于后端反查完整元信息，
 * mimeType 用于前端区分 file/image content block。
 * 其余字段（minioKey/filename/sizeBytes 等）属实现细节，不进入参数边界。
 */
export type ChatUploadedFileRef = Pick<UploadedFileInfo, 'fileId' | 'mimeType'>;

/**
 * file_metadata 行的前端形态。
 *
 * 注：`messageId` / `id` 均为 uuid 字符串（与 chat_message.id 同构）。
 */
export interface fileMetadataType {
  id: string;
  messageId: string;
  sessionId: UUIDTypes;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  minioBucket: string;
  minioKey: string;
  uploadedAt: Date;
}

/**
 * subagent 内部工具调用（嵌套在 subagent_task part.content.children 里）
 */
export interface SubagentToolCall {
  id: string;
  toolCallId: string;
  name: string;
  args?: unknown;
  result?: unknown;
  success?: boolean;
  errorMessage?: string;
  status: 'running' | 'done' | 'failed';
}

/**
 * subagent 解析自 final-report fenced block 的结构化报告，
 * 与 backend SubagentReportSchema 字段一致（type-only mirror，无运行期校验）。
 */
export interface SubagentStructuredReport {
  summary: string;
  keyFindings: Array<{ point: string; sourceIndexes: number[] }>;
  sources: Array<{ title: string; url: string; snippet?: string }>;
  issues?: string[];
}

/**
 * MessagePart —— 消息分块单元（前后端共享契约）
 *
 * 一条 ChatMessageType 由一个 parts[] 时序数组组成，每个 part 用 partId 唯一标识。
 *
 * 九种 part_type：
 *  - text          AI/用户的正文文本片段（同类相邻合并）
 *  - reasoning     AI 推理/规划（同类相邻合并）
 *  - tool_call     单次工具调用，结果回写到本 part 的 content（status / result / success）
 *  - tool_result   仅当 result 先于 call 到达且无法关联时作为兜底独立 part
 *  - subagent_task 子代理任务，按 taskId upsert；children 内嵌子工具调用
 *  - file / image  用户上传的附件块（仅在 user message 中出现）
 *  - artifact      最终产物（如研究报告 markdown）
 *  - task_summary  多 agent 工作流的任务总结（完成 N 个子任务 + 每子任务关键发现）
 */
export type MessagePart =
  | {
      partId: string;
      type: 'text';
      createdAt: number;
      content: { text: string };
    }
  | {
      partId: string;
      type: 'reasoning';
      createdAt: number;
      content: { text: string };
    }
  | {
      partId: string;
      type: 'tool_call';
      createdAt: number;
      content: {
        toolCallId: string;
        name: string;
        args?: unknown;
        result?: unknown;
        success?: boolean;
        errorMessage?: string;
        status: 'running' | 'done' | 'failed';
      };
    }
  | {
      partId: string;
      type: 'tool_result';
      createdAt: number;
      content: {
        toolCallId: string;
        result: unknown;
        success: boolean;
        errorMessage?: string;
      };
    }
  | {
      partId: string;
      type: 'subagent_task';
      createdAt: number;
      content: {
        taskId: string;
        description?: string;
        subagentType?: string;
        status: string;
        result?: string;
        error?: string;
        reasoning?: string;
        children?: SubagentToolCall[];
        structured?: SubagentStructuredReport | null;
      };
    }
  | {
      partId: string;
      type: 'file';
      createdAt: number;
      content: {
        fileId: string;
        filename?: string;
        mimeType?: string;
        sizeBytes?: number;
      };
    }
  | {
      partId: string;
      type: 'image';
      createdAt: number;
      content: {
        fileId: string;
        filename?: string;
        mimeType?: string;
        sizeBytes?: number;
      };
    }
  | {
      partId: string;
      type: 'artifact';
      createdAt: number;
      content: { title: string; markdown: string };
    }
  | {
      partId: string;
      type: 'task_summary';
      createdAt: number;
      content: { text: string };
    };

export type MessagePartType = MessagePart['type'];

/** 渲染层用的派生 timeline step 子集（不含 text/file/image/artifact/tool_result） */
export type TimelineStepPart = Extract<
  MessagePart,
  { type: 'reasoning' | 'tool_call' | 'subagent_task' }
>;

/** MessageTimeline 渲染组件 props（组件名保留，类型重命名以避免冲突） */
export interface MessageTimelineProps {
  steps: TimelineStepPart[];
  status: 'idle' | 'processing' | 'interrupt' | 'end' | 'failed';
  interrupt?: { question: string; details: unknown } | null;
}

// 类型守卫

export const isTextPart = (p: MessagePart): p is Extract<MessagePart, { type: 'text' }> =>
  p.type === 'text';
export const isReasoningPart = (p: MessagePart): p is Extract<MessagePart, { type: 'reasoning' }> =>
  p.type === 'reasoning';
export const isToolCallPart = (p: MessagePart): p is Extract<MessagePart, { type: 'tool_call' }> =>
  p.type === 'tool_call';
export const isToolResultPart = (
  p: MessagePart,
): p is Extract<MessagePart, { type: 'tool_result' }> => p.type === 'tool_result';
export const isSubagentTaskPart = (
  p: MessagePart,
): p is Extract<MessagePart, { type: 'subagent_task' }> => p.type === 'subagent_task';
export const isFilePart = (p: MessagePart): p is Extract<MessagePart, { type: 'file' }> =>
  p.type === 'file';
export const isImagePart = (p: MessagePart): p is Extract<MessagePart, { type: 'image' }> =>
  p.type === 'image';
export const isArtifactPart = (p: MessagePart): p is Extract<MessagePart, { type: 'artifact' }> =>
  p.type === 'artifact';
export const isTaskSummaryPart = (
  p: MessagePart,
): p is Extract<MessagePart, { type: 'task_summary' }> => p.type === 'task_summary';

/**
 * ChatMessageType —— 一条消息（user / assistant 同构）
 *
 * - id / sessionId：均为 uuid 字符串
 * - parts：按到达时序排列的内容块数组（持久化在 chat_message.parts jsonb）
 * - interrupt：human-in-the-loop 中断（独立挂顶层，不进入 parts；仅 assistant 消息可有）
 */
export interface ChatMessageType {
  id: string;
  sessionId: UUIDTypes;
  role: 'user' | 'assistant';
  parts: MessagePart[];
  createdAt: number;
  /** 与消息关联的文件元信息（由 history 接口在 user message 上补全；流式期间不维护） */
  files?: fileMetadataType[];
  /** human-in-the-loop 中断（仅流式 assistant 消息可有） */
  interrupt?: { question: string; details: unknown } | null;
}

export interface ChatSessionType {
  id: UUIDTypes;
  seq_id: number;
  title: string;
  created_at: number;
  updated_at: number;
}
