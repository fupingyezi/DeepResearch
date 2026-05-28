import { StreamChatHandler } from "./stream-chat-handler";
import { chatWithAgentProps } from "@/types";

/**
 * 合并版统一 chat 入口（对齐 deer-flow 2.0）：
 *
 * - 不再有"联网搜索 / 深度研究"档位；
 * - 是否进入深度研究流程由后端 lead-agent 自主判断（subagent 永远启用）；
 * - metadata 仅携带模型选择 / 业务字段，不再透传 is_plan_mode / subagent_enabled / agent_name。
 *
 * 兼容性：
 * - chatWithAgentProps 仍保留 enableDeepResearch / enableSearch 字段为 deprecated，
 *   但本函数不再消费这两个字段。
 * - 历史消息的 mode 标签统一写为 'chat'；旧记录上的 'deepResearch' / 'search'
 *   保持只读兼容（DB CHECK 约束未改）。
 */
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

  // agentType 字段保留（StreamChatConfig 类型里仍存在），统一固定为 'basic'
  // 表示"由后端 lead-agent 自主判断"。前端不再做三档分支。
  const agentType: "basic" | "search" | "deep_research" = "basic";

  // 历史消息 mode 标签：新消息一律 'chat'，旧记录的 'deepResearch'/'search'
  // 保留兼容（DB schema 不动）。
  const mode: "chat" | "search" | "deepResearch" = "chat";

  // metadata 只携带模型选择 + 业务字段；不再透传 plan-mode 三开关。
  const extraMetadata: Record<string, any> = {};
  if (modelKey) extraMetadata.modelKey = modelKey;

  const handler = new StreamChatHandler({
    agentType,
    mode,
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
