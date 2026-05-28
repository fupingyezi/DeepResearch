import { StreamChatHandler } from "./stream-chat-handler";
import { chatWithAgentProps } from "@/types";

/**
 * 合并版统一 chat 入口（对齐 deer-flow 的渲染范式）：
 *
 * - 工作流（plan / tasks / interrupt / 思考过程）一律内联在当前 assistant 消息的
 *   `timeline` 字段，由 ChatMessageBubble 渲染在气泡里；
 * - 右侧 ArtifactPanel 仅用于打开/查看产物（report 等）；
 * - 是否走 plan-mode / subagent / 联网搜索，全部由 metadata 控制，前端不再分三套链路。
 *
 * 默认契约：
 *   enableDeepResearch=true（默认）→ is_plan_mode=true, subagent_enabled=true,
 *                                     agent_name=lead-research, agentType=deep_research
 *   enableDeepResearch=false        → is_plan_mode=false, subagent_enabled=false
 *     · enableSearch=true           → agentType=search
 *     · enableSearch=false / 缺省   → agentType=basic
 */
export const chatWithAgent = async (params: chatWithAgentProps) => {
  const {
    inputValue,
    callingMode,
    isResume,
    hasFiles,
    uploadedFiles,
    enableDeepResearch = false,
    enableSearch = false,
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

  // 1) 计算 agentType / mode（mode 字段仅用于历史消息标签，与 UI 渲染无关）
  const agentType: "basic" | "search" | "deep_research" = enableDeepResearch
    ? "deep_research"
    : enableSearch
    ? "search"
    : "basic";

  const mode: "chat" | "search" | "deepResearch" = enableDeepResearch
    ? "deepResearch"
    : enableSearch
    ? "search"
    : "chat";

  // 2) 计算 metadata（plan-mode 三开关）
  const extraMetadata: Record<string, any> = enableDeepResearch
    ? {
        is_plan_mode: true,
        subagent_enabled: true,
        agent_name: "lead-research",
      }
    : {
        is_plan_mode: false,
        subagent_enabled: false,
      };
  if (modelKey) extraMetadata.modelKey = modelKey;

  // 3) 唯一一条流式链路
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
