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
// 向后兼容别名：保留旧的 chatWithChatAssistant / chatWithSearhAssistant /
// chatWithDeepResearch / reChatWithAssistant 作为薄壳，内部统一走 chatWithAgent。
// 上层调用处可以渐进式迁移到 chatWithAgent。
// ------------------------------------------------------------------

export const chatWithChatAssistant = (params: chatWithAgentProps) =>
  chatWithAgent({
    ...params,
    enableDeepResearch: false,
    enableSearch: false,
  });

export const chatWithSearhAssistant = (params: chatWithAgentProps) =>
  chatWithAgent({
    ...params,
    enableDeepResearch: false,
    enableSearch: true,
  });

export const chatWithDeepResearch = (params: chatWithAgentProps) =>
  chatWithAgent({
    ...params,
    enableDeepResearch: true,
  });

export const reChatWithAssistant = reChatWithAgent;
