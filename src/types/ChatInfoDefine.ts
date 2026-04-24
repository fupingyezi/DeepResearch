import { ContentBlock } from "langchain";
import { UUIDTypes } from "uuid";

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
  status: string;
  needSearch?: boolean;
  searchResult?: searchResultItem[];
  result?: string;
}

export interface deepResearchResultType {
  id?: number;
  messageId: number;
  sessionId: UUIDTypes;
  researchTarget: string;
  tasks: taskType[];
  report: string;
}

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

export interface ChatMessageType {
  id: number;
  sessionId: UUIDTypes;
  role: string;
  content: string | ContentBlock[];
  mode: "chat" | "search" | "deepResearch";
  files?: fileMetadataType[];
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
