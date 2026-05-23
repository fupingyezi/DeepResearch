import { StreamChatHandler } from "./stream-chat-handler";
import { chatWithChatAssistantProps } from "@/types";

export const chatWithChatAssistant = async (
  params: chatWithChatAssistantProps
) => {
  const handler = new StreamChatHandler({
    agentType: "basic",
    mode: "chat",
    hasFiles: params.hasFiles,
    uploadedFiles: params.uploadedFiles,
    callingMode: params.callingMode,
    inputValue: params.inputValue,
    sessionId: params.currentSessionId,
    chatSessions: params.chatSessions,
    currentMessages: params.currentMessages,
    setIsChating: params.setIsChating,
    setShouldAutoScroll: params.setShouldAutoScroll,
    addChatSession: params.addChatSession,
    setCurrentSessionId: params.setCurrentSessionId,
    setCurrentMessages: params.setCurrentMessages,
    setAbortController: params.setAbortController,
    setCurrentDeepResearchId: () => {},

    extraMetadata: {
      is_plan_mode: false,
      subagent_enabled: false,
    },
  });

  await handler.execute();
};

