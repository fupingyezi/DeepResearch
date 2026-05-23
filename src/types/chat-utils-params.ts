import { ConversationState, DeepResearchProcessState } from "@/store";

export interface chatWithChatAssistantProps extends ConversationState {
  inputValue: string;
  hasFiles?: boolean;
  uploadedFiles?: any[];
  callingMode: "direct" | "reEditCall" | "recall";
}

export interface chatWithDeepResearchProps
  extends ConversationState,
    DeepResearchProcessState {
  inputValue: string;
  callingMode: "direct" | "reEditCall" | "recall" | "resume";
  isResume?: boolean;
}

export interface reChatWithAssistantProps
  extends ConversationState,
    DeepResearchProcessState {
  inputValue: string;
  callingMode: "reEditCall" | "recall";
  mode: "chat" | "search" | "deepResearch";
}
