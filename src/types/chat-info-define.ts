import { ContentBlock } from "langchain";
import { UUIDTypes } from "uuid";

export type UploadedFileStatus = "pending" | "parsing" | "success" | "failed";

export interface UploadedFile {
  id: string;
  file: File;
  parsedStatus: UploadedFileStatus;
  sizeBytes?: number;
  error?: string;
}

export interface fileMetadataType {
  id: UUIDTypes;
  messageId: number;
  sessionId: UUIDTypes;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  minioBucket: string;
  minioKey: string;
  uploadedAt: Date;
}

/**
 * 内联在 chat 气泡里的"工作流时序步骤"
 *
 * 完全对齐 deer-flow 的 ChainOfThought：所有 reasoning / tool_call / subagent
 * 子任务等都按照后端事件到达的时序追加为 step，由 ChatMessageBubble 内嵌
 * 渲染。前端**不再做任何"研究/搜索/聊天"的概念区分**。
 *
 * 三种 step 形态：
 * - reasoning：思考/计划/简要分析等模型内省文本（合并相邻 chunk）
 * - tool_call：单次工具调用（用 toolCallId 关联 result）
 * - subagent_task：基于 task_progress / state_update.task_* 的子代理任务，
 *   带 children 子工具调用 + 解析后的结构化报告
 */

/** subagent 内部工具调用（嵌套在 subagent_task.children 里） */
export interface SubagentToolCall {
  id: string;
  toolCallId: string;
  name: string;
  args?: any;
  result?: any;
  success?: boolean;
  errorMessage?: string;
  status: "running" | "done" | "failed";
}

/**
 * subagent 解析自 final-report fenced block 的结构化报告，
 * 与 backend SubagentReportSchema 保持字段一致（type-only mirror，无运行期校验）。
 */
export interface SubagentStructuredReport {
  summary: string;
  keyFindings: Array<{ point: string; sourceIndexes: number[] }>;
  sources: Array<{ title: string; url: string; snippet?: string }>;
  issues?: string[];
}

export type CoTStep =
  | {
      kind: "reasoning";
      id: string;
      text: string;
    }
  | {
      kind: "tool_call";
      id: string;
      /** 后端 toolCallId（用于把 TOOL_RESULT 关联回来） */
      toolCallId?: string;
      name: string;
      args?: any;
      result?: any;
      success?: boolean;
      errorMessage?: string;
      status: "running" | "done" | "failed";
    }
  | {
      kind: "subagent_task";
      id: string;
      /** 后端 taskId（用于 upsert） */
      taskId: string;
      description?: string;
      subagentType?: string;
      status: string; // started / running / completed / failed / cancelled / timed_out
      result?: string;
      error?: string;
      /** subagent 内部工具调用按时序追加 */
      children?: SubagentToolCall[];
      /** 解析自 final-report 的结构化报告（completed 后有值） */
      structured?: SubagentStructuredReport | null;
      /** sub-agent 执行过程中的思考/规划文本（可折叠显示） */
      reasoning?: string;
    };

/**
 * 消息内联时间线。
 */
export interface MessageTimeline {
  /** 顺序事件流；空表示这条消息没有任何工具调用/思考过程，直接看正文即可 */
  steps: CoTStep[];
  /** 当前阶段总状态 */
  status: "idle" | "processing" | "interrupt" | "end" | "failed";
  /** human-in-the-loop 中断（仅 status==='interrupt' 时有效） */
  interrupt?: { question: string; details: any } | null;
}

/**
 * 最终产物（如研究报告 / 文件等），脱离工作流时序，独立挂在消息上。
 * 由右侧 ArtifactPanel 展示，气泡里仅给一个入口卡片。
 */
export interface MessageArtifact {
  title: string;
  /** markdown 文本内容 */
  content: string;
}

export interface ChatMessageType {
  id: number;
  sessionId: UUIDTypes;
  role: string;
  content: string | ContentBlock[];
  files?: fileMetadataType[];
  /** 工作流时序步骤（内联在气泡里展示） */
  timeline?: MessageTimeline;
  /** 产物（点击气泡入口卡片时由右侧 ArtifactPanel 打开） */
  artifact?: MessageArtifact;
}

export interface ChatSessionType {
  id: UUIDTypes;
  seq_id: number;
  title: string;
  created_at: number;
  updated_at: number;
}
