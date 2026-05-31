import { createMiddleware } from 'langchain';

/**
 * TitleMiddleware（features.autoTitle 启用）
 *
 * 职责（占位）：
 * - 在首轮对话结束（afterModel / afterAgent）后，根据用户首条消息生成会话标题，
 *   写入 ThreadState.title，仅在 title 为空时触发。
 */
export const titleMiddleware = createMiddleware({
  name: 'TitleMiddleware',
});
