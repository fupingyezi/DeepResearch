import { createMiddleware } from 'langchain';

/**
 * SummarizationMiddleware（位序 6 / features.summarization 启用）
 *
 * 职责（占位）：
 * - 在 beforeModel 检测消息长度 / token 阈值，超出时调用 LLM 进行摘要并替换历史，
 *   控制上下文窗口。
 *
 * 注意：
 * - features.summarization 不允许 true（默认实现可能产生额外 LLM 调用与费用），
 *   必须由调用方显式传入定制实现。
 */
export const summarizationMiddleware = createMiddleware({
  name: 'SummarizationMiddleware',
});
