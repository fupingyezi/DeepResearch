import { ContentBlock } from "langchain";
import { UUIDTypes } from "uuid";


export type SSEEvent =
  | { type: "start"; timestamp: number }
  | { type: "content"; content: string; role: string; id?: string | number }
  | { type: "state"; payload: Record<string, any> } // 用于 deep-research
  | { type: "done"; done: true }
  | { type: "error"; content: string; done: true };

export interface searchResultItem {
  title: string;
  sourceUrl: string;
  content: string;
  relativeScore: number;
}

export interface taskType {
  id: string; // 数据库用的UUID
  taskId: string; // AI生成的步骤标识
  description: string;
  // status: "pending" | "searched" | "failed_attempt" | "processed";
  status: string;
  needSearch?: boolean;
  searchResult?: searchResultItem[];
  result?: string;
  // feedback: string;
}

export interface deepResearchResultType {
  id?: number;
  messageId: number;
  sessionId: UUIDTypes;
  researchTarget: string;
  tasks: taskType[];
  report: string;
}

export interface ChatMessageType {
  id: number;
  sessionId: UUIDTypes;
  role: string;
  content: string | ContentBlock[];
  mode: "chat" | "search" | "deepResearch";
  files?: any[];
  accumulatedTokenUsage?: number;
  deepResearchResult?: deepResearchResultType;
  researchStatus?: "finished" | "failed" | "processing" | "suspended";
}

export interface ChatSessionType {
  id: UUIDTypes;
  seq_id: number;
  title: string;
  created_at: number;
  updated_at: number;
}

