import { StreamChatHandler } from "./stream-chat-handler";
import { chatWithChatAssistantProps } from "@/types";

export const chatWithSearhAssistant = async (
  params: chatWithChatAssistantProps
) => {
  const handler = new StreamChatHandler({
    agentType: "search",
    mode: "search",
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

    // search 链路同样不需要 task 工具：显式关闭 subagent，
    // 避免命中 DeerFlowClient.baseOptions.subagentEnabled=true 的默认开关。
    extraMetadata: {
      is_plan_mode: false,
      subagent_enabled: false,
      ...(params.modelKey && { modelKey: params.modelKey }),
    },
  });

  await handler.execute();
};

