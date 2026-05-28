import { ConversationState } from "@/store";

/**
 * 合并三种 chatWith~~~ 入口后，统一使用 chatWithAgentProps。
 * - 不再区分 chat / search / deepResearch 三种 mode 的前端分支：
 *   工作流（plan / tasks / interrupt）一律内联在 chat 气泡里渲染，
 *   是否触发 plan-mode / subagent / 联网搜索 由后端 metadata 决定。
 * - mode 字段保留（仅用于历史消息展示与持久化），默认 "chat"。
 */
export interface chatWithAgentProps extends ConversationState {
  inputValue: string;
  hasFiles?: boolean;
  uploadedFiles?: any[];
  callingMode: "direct" | "reEditCall" | "recall" | "resume";
  isResume?: boolean;
  /** 历史标签：是否走 plan/subagent。默认 true（深度研究 + 联网） */
  enableDeepResearch?: boolean;
  /** 历史标签：是否启用搜索工具（不开 plan）。默认与 enableDeepResearch 联动 */
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
  enableDeepResearch?: boolean;
  enableSearch?: boolean;
  modelKey?: string;
}

// 旧别名（保留以避免大面积破坏外部引用）
export type chatWithChatAssistantProps = chatWithAgentProps;
export type chatWithDeepResearchProps = chatWithAgentProps;
export type reChatWithAssistantProps = reChatWithAgentProps;
