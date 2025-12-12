import { ContentBlock } from "langchain";
import { UUIDTypes } from "uuid";
import { ConversationState, DeepResearchProcessState } from "@/store";
import { taskType, searchResultItem } from "./agentFlowRelatedDefine";

export interface ChatMessageType {
  id: number;
  sessionId: UUIDTypes;
  role: string;
  content: string | ContentBlock[];
  mode: "chat" | "search" | "deepResearch";
  files?: any[];
  accumulatedTokenUsage?: number;
  deepResearchResult?: deepResearchResultType;
  researchStatus?: "finished" | "failed";
}

export interface deepResearchResultType {
  id?: number;
  messageId: number;
  sessionId: UUIDTypes;
  researchTarget: string;
  tasks: taskType[];
  report: string;
}

export interface ChatSessionType {
  id: UUIDTypes;
  seq_id: number;
  title: string;
  created_at: number;
  updated_at: number;
}

export interface chatWithChatAssistantProps extends ConversationState {
  inputValue: string;
  callingMode: "direct" | "reEditCall" | "recall";
}

export interface chatWithDeepResearchProps
  extends ConversationState,
    DeepResearchProcessState {
  inputValue: string;
  callingMode: "direct" | "reEditCall" | "recall";
}
