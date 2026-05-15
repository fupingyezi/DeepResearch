import { createMiddleware } from 'langchain';

/**
 * SubagentLimitMiddleware（位序 11 / features.subagent 启用）
 *
 * 职责（占位）：
 * - 限制子 agent 调用深度 / 数量 / token 预算，防止 lead-agent → subagent 形成无限递归。
 */
export const subagentLimitMiddleware = createMiddleware({
  name: 'SubagentLimitMiddleware',
});
