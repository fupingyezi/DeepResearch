import { chatWithAgent } from "./chat-with-agent";
import { StreamChatConfig, StreamChatHandler } from "./stream-chat-handler";
import type { chatWithAgentProps, reChatWithAgentProps } from "@/types";

export type { StreamChatConfig };
export { chatWithAgent, StreamChatHandler };

/**
 * 重新编辑 / 重新生成入口：与 chatWithAgent 共用同一条链路。
 * 上层只需要把 callingMode 设为 'reEditCall' 或 'recall' 即可。
 */
export async function reChatWithAgent(params: reChatWithAgentProps) {
  await chatWithAgent({
    ...params,
    callingMode: params.callingMode,
  });
}

// ------------------------------------------------------------------
// 向后兼容别名（deer-flow 2.0 重构后）：
// 旧调用点 chatWithChatAssistant / chatWithSearhAssistant /
// chatWithDeepResearch / reChatWithAssistant 全部统一走 chatWithAgent。
// 是否进入深度研究流程由后端 lead-agent 自主判断，前端不再传 enable* 标志。
// 这些别名仅作为薄壳，便于上层渐进式迁移。
// ------------------------------------------------------------------

export const chatWithChatAssistant = (params: chatWithAgentProps) =>
  chatWithAgent(params);

export const chatWithSearhAssistant = (params: chatWithAgentProps) =>
  chatWithAgent(params);

export const chatWithDeepResearch = (params: chatWithAgentProps) =>
  chatWithAgent(params);

export const reChatWithAssistant = reChatWithAgent;
