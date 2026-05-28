import { AgentMiddleware } from 'langchain';

/**
 * Feature toggle type - false: disable, true: default, M: custom middleware
 */
export type FeatureToggle<M extends AgentMiddleware = AgentMiddleware> = false | true | M;

export interface RuntimeFeatures {
  sandbox?: FeatureToggle;
  memory?: FeatureToggle;
  summarization?: FeatureToggle; // 不允许 true
  /**
   * @deprecated 自 deerflow2 重构起，lead-agent 永远启用 subagent 能力
   * （taskTool + subagentLimitMiddleware 始终注入）。该字段保留仅为向后兼容
   * 旧调用点的字段穿透，新代码请勿读写。
   */
  subagent?: FeatureToggle;
  vision?: FeatureToggle;
  autoTitle?: FeatureToggle;
  guardrail?: FeatureToggle; // 不允许 true
  qwenToolCallRecovery?: FeatureToggle;
}

export const DEFAULT_FEATURES: RuntimeFeatures = {
  sandbox: false,
  memory: false,
  summarization: false,
  vision: false,
  autoTitle: false,
  guardrail: false,
};

export interface PositionedMiddleware extends AgentMiddleware {
  _nextAnchor?: new (...args: any[]) => AgentMiddleware;
  _prevAnchor?: new (...args: any[]) => AgentMiddleware;
}

/**
 *  标记中间件插入锚点的位置：前/后
 */
export function Next<T extends new (...args: any[]) => AgentMiddleware>(anchor: T) {
  return function <U extends new (...args: any[]) => AgentMiddleware>(target: U): U {
    (target as PositionedMiddleware)._nextAnchor = anchor;
    return target;
  };
}

export function Prev<T extends new (...args: any[]) => AgentMiddleware>(anchor: T) {
  return function <U extends new (...args: any[]) => AgentMiddleware>(target: U): U {
    (target as PositionedMiddleware)._prevAnchor = anchor;
    return target;
  };
}
