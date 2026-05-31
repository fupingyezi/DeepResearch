import { chatWithAgent } from './chat-with-agent';
import { StreamChatConfig, StreamChatHandler } from './stream-chat-handler';
import type { reChatWithAgentProps } from '@/types';

export type { StreamChatConfig };
export { chatWithAgent, StreamChatHandler };

/**
 * 重新编辑 / 重新生成入口：与 chatWithAgent 共用同一条链路。
 * 上层只需要把 operation 设为 'reEditCall' 或 'recall' 即可。
 */
export async function reChatWithAgent(params: reChatWithAgentProps) {
  await chatWithAgent({
    ...params,
    operation: params.operation,
  });
}
