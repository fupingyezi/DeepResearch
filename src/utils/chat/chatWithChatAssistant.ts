import { StreamChatHandler } from "./streamChatHandler";
import { chatWithChatAssistantProps } from "@/types";

export const chatWithChatAssistant = async (
  params: chatWithChatAssistantProps
) => {
  const handler = new StreamChatHandler({
    apiEndpoint: "/api/chat/basic_agents",
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
  });

  await handler.execute();
};
