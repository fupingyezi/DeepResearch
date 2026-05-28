import { ConversationState } from "@/store";

/**
 * 统一聊天入口参数。
 * 是否进入深度研究流程由后端 lead-agent 自主判断，前端不再传任何档位字段。
 */
export interface chatWithAgentProps extends ConversationState {
  inputValue: string;
  hasFiles?: boolean;
  uploadedFiles?: any[];
  callingMode: "direct" | "reEditCall" | "recall" | "resume";
  isResume?: boolean;
  /** 模型选择 */
  modelKey?: string;
}

/**
 * 重新编辑/重试时使用，落在与 chatWithAgent 一致的合并入口上。
 */
export interface reChatWithAgentProps extends ConversationState {
  inputValue: string;
  callingMode: "reEditCall" | "recall";
  modelKey?: string;
}
