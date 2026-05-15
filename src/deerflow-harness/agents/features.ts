import { AgentMiddleware } from 'langchain';

/**
 * Feature toggle type - false: disable, true: default, M: custom middleware
 */
export type FeatureToggle<M extends AgentMiddleware = AgentMiddleware> = false | true | M;

export interface RuntimeFeatures {
  sandbox?: FeatureToggle;
  memory?: FeatureToggle;
  summarization?: FeatureToggle; // 不允许 true
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
  subagent: false,
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
