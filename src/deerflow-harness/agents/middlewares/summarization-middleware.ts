import { AgentMiddleware, summarizationMiddleware as lcSummarizationMiddleware } from 'langchain';
import { createMiddleware } from 'langchain';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

/**
 * SummarizationMiddleware
 *
 * 优先复用 LangChain 现成的 summarizationMiddleware：当历史 token 触达阈值时
 * 自动摘要较旧消息、保留近窗口，维持上下文连续性（AI/Tool 消息成对保留）。
 *
 * features.summarization 不允许 true（默认实现会产生额外 LLM 调用与费用），
 * 必须由调用方通过 createSummarizationMiddleware(model, ...) 显式构造后传入。
 *
 * 占位 summarizationMiddleware 仅用于 ORDERED_MIDDLEWARES 文档位序常量，
 * 真实装配请用 createSummarizationMiddleware()。
 */
export const summarizationMiddleware = createMiddleware({
  name: 'SummarizationMiddleware',
});

export interface SummarizationOptions {
  /** 触发摘要的 token 阈值（默认 12000）。 */
  triggerTokens?: number;
  /** 保留的近窗口消息条数（默认 8）。 */
  keepMessages?: number;
}

/**
 * 用当前 agent 的 model 构造现成的 summarizationMiddleware 实例。
 * 供调用方在 features.summarization 中传入（features 不允许 true）。
 */
export function createSummarizationMiddleware(
  model: BaseChatModel,
  options?: SummarizationOptions,
): AgentMiddleware {
  return lcSummarizationMiddleware({
    model,
    trigger: { tokens: options?.triggerTokens ?? 12000 },
    keep: { messages: options?.keepMessages ?? 8 },
  }) as AgentMiddleware;
}
