import { ConversationState } from "@/store";

/**
 * 合并三种 chatWith~~~ 入口后，统一使用 chatWithAgentProps（deer-flow 2.0 风格）。
 * - 不再有 chat / search / deepResearch 三档；
 * - 是否进入深度研究流程由后端 lead-agent 自主判断；
 * - mode 字段保留（仅用于历史消息展示与持久化），新消息默认 "chat"。
 */
export interface chatWithAgentProps extends ConversationState {
  inputValue: string;
  hasFiles?: boolean;
  uploadedFiles?: any[];
  callingMode: "direct" | "reEditCall" | "recall" | "resume";
  isResume?: boolean;
  /**
   * @deprecated 自 deer-flow 2.0 重构起，前端不再有"深度研究"档位；
   * 是否触发深度研究由后端 lead-agent 自主判断。该字段保留仅为兼容旧调用点，
   * 实际不会被消费。
   */
  enableDeepResearch?: boolean;
  /**
   * @deprecated 自 deer-flow 2.0 重构起，前端不再有"联网搜索"档位；
   * 是否调用 search_web_tool 由 lead-agent 自主决定。
   */
  enableSearch?: boolean;
  /** 模型选择 */
  modelKey?: string;
}

/**
 * 重新编辑/重试时使用，落在与 chatWithAgent 一致的合并入口上。
 */
export interface reChatWithAgentProps extends ConversationState {
  inputValue: string;
  callingMode: "reEditCall" | "recall";
  /**
   * @deprecated 同 chatWithAgentProps.enableDeepResearch。
   */
  enableDeepResearch?: boolean;
  /**
   * @deprecated 同 chatWithAgentProps.enableSearch。
   */
  enableSearch?: boolean;
  modelKey?: string;
}

// 旧别名（保留以避免大面积破坏外部引用）
export type chatWithChatAssistantProps = chatWithAgentProps;
export type chatWithDeepResearchProps = chatWithAgentProps;
export type reChatWithAssistantProps = reChatWithAgentProps;
