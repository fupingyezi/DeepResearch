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

    // 普通 chat 链路必须显式关闭 plan-mode 与 subagent，否则后端
    // DeerFlowClient 进程级单例的 baseOptions.subagentEnabled 默认为 true，
    // 会让 lead agent 也看到 `task` 工具。Qwen 在用户问"调研类"问题时
    // 会直接调 `task(description, prompt)`，但 schema 不匹配 → ToolNode 报
    // `Tool "unknown" not found.` 把整次 stream 打死。
    extraMetadata: {
      is_plan_mode: false,
      subagent_enabled: false,
    },
  });

  await handler.execute();
};

