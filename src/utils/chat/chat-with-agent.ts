import { StreamChatHandler } from './stream-chat-handler';
import { chatWithAgentProps } from '@/types';

export const chatWithAgent = async (params: chatWithAgentProps) => {
  const {
    inputValue,
    operation,
    resumeDecision,
    uploadedFiles,
    model,

    // ConversationState 注入
    chatSessions,
    currentSessionId,
    currentMessages,
    setIsChating,
    setShouldAutoScroll,
    addChatSession,
    updateChatSession,
    setCurrentSessionId,
    setCurrentMessages,
    setAbortController,
  } = params;

  const handler = new StreamChatHandler({
    operation,
    resumeDecision,
    inputValue,
    uploadedFiles,
    sessionId: currentSessionId,
    chatSessions,
    currentMessages,
    setIsChating,
    setShouldAutoScroll,
    addChatSession,
    updateChatSession,
    setCurrentSessionId,
    setCurrentMessages,
    setAbortController,
    model,
  });

  await handler.execute();
};
