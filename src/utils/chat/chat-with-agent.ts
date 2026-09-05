import { StreamChatHandler } from './stream-chat-handler';
import { chatWithAgentProps } from '@/types';
import { v4 as uuidv4 } from 'uuid';

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
    setShouldAutoScroll,
    setCurrentSessionId,
    addChatSession,
    updateChatSession,
    // 多对话并行：按 sessionId 分桶写回
    setSessionMessages,
    setSessionStatus,
    setSessionAbortController,
    migrateSessionRuntime,
  } = params;

  // 新建对话（无 currentSessionId 且非续跑/重试）：先生成临时 sessionId 并切为当前对话，
  // 使后续按临时 id 分桶的写回能投影到当前视图；START 收到真实 id 后由 handler 迁移桶。
  let sessionId = currentSessionId;
  let isNewSession = false;
  if (!sessionId && operation === undefined) {
    sessionId = uuidv4();
    isNewSession = true;
    setCurrentSessionId(sessionId);
  }

  const handler = new StreamChatHandler({
    operation,
    resumeDecision,
    inputValue,
    uploadedFiles,
    sessionId,
    isNewSession,
    chatSessions,
    currentMessages,
    setShouldAutoScroll,
    addChatSession,
    updateChatSession,
    setSessionMessages,
    setSessionStatus,
    setSessionAbortController,
    migrateSessionRuntime,
    model,
  });

  await handler.execute();
};
