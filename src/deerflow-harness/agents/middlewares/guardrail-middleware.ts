import { createMiddleware } from 'langchain';

/**
 * GuardrailMiddleware（位序 4 / features.guardrail 启用）
 *
 * 职责（占位）：
 * - 入参/出参合规检查：敏感词、注入、隐私 PII；命中时可改写或终止。
 *
 * 注意：
 * - features.guardrail 不允许 true（必须显式传入实现），避免默认放行造成安全隐患。
 */
export const guardrailMiddleware = createMiddleware({
  name: 'GuardrailMiddleware',
});
