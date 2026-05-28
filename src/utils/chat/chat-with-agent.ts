import { StreamChatHandler } from "./stream-chat-handler";
import { chatWithAgentProps } from "@/types";

export const chatWithAgent = async (params: chatWithAgentProps) => {
  const {
    inputValue,
    callingMode,
    isResume,
    hasFiles,
    uploadedFiles,
    modelKey,

    // ConversationState 注入
    chatSessions,
    currentSessionId,
    currentMessages,
    setIsChating,
    setShouldAutoScroll,
    addChatSession,
    setCurrentSessionId,
    setCurrentMessages,
    setAbortController,
  } = params;

  const extraMetadata: Record<string, any> = {};
  if (modelKey) extraMetadata.modelKey = modelKey;

  const handler = new StreamChatHandler({
    callingMode,
    isResume,
    inputValue,
    hasFiles,
    uploadedFiles,
    sessionId: currentSessionId,
    chatSessions,
    currentMessages,
    setIsChating,
    setShouldAutoScroll,
    addChatSession,
    setCurrentSessionId,
    setCurrentMessages,
    setAbortController,
    extraMetadata,
  });

  await handler.execute();
};
