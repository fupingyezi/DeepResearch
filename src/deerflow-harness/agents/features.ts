/**
 * Agent Features — 保留接口，最小版本暂不使用中间件系统
 */

export interface RuntimeFeatures {
  sandbox?: boolean;
  memory?: boolean;
  summarization?: boolean;
  subagent?: boolean;
  vision?: boolean;
  autoTitle?: boolean;
  guardrail?: boolean;
}

export const DEFAULT_FEATURES: RuntimeFeatures = {
  sandbox: false,
  memory: false,
  summarization: false,
  subagent: false,
  vision: false,
  autoTitle: false,
  guardrail: false,
};
