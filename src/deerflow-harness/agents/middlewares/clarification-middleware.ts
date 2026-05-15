import { createMiddleware } from 'langchain';

/**
 * ClarificationMiddleware（位序 13 / 始终最后）
 *
 * 职责（占位）：
 * - 必须排在所有中间件最后：当上游产生不可继续状态时，向用户发起澄清提问 / interrupt，
 *   是面向用户的"最后一道兜底"。
 */
export const clarificationMiddleware = createMiddleware({
  name: 'ClarificationMiddleware',
});
