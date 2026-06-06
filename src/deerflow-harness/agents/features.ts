import { AgentMiddleware } from 'langchain';

/**
 * Feature toggle type - false: disable, true: default, M: custom middleware
 */
export type FeatureToggle<M extends AgentMiddleware = AgentMiddleware> = false | true | M;

export interface RuntimeFeatures {
  sandbox?: FeatureToggle;
  memory?: FeatureToggle;
  summarization?: FeatureToggle; // 不允许 true（须传 createSummarizationMiddleware 实例）
  todo?: FeatureToggle; // 现成 todoListMiddleware；true=默认实现
  vision?: FeatureToggle; // viewImageMiddleware（当前为占位 + 警告）
  autoTitle?: FeatureToggle;
  /** ThreadDataMiddleware：beforeAgent 从 file_metadata 装载本会话上传文件到 state。 */
  threadData?: FeatureToggle;
  /** UploadsMiddleware：把 state.uploadedFiles 渲染为 SystemMessage 注入 prompt。 */
  uploads?: FeatureToggle;
  guardrail?: FeatureToggle; // 不允许 true
  qwenToolCallRecovery?: FeatureToggle;
  /** 是否注入 task 工具 + subagentLimit 中间件（subagent 委派能力）。*/
  subagents?: FeatureToggle;
}

export const DEFAULT_FEATURES: RuntimeFeatures = {
  sandbox: false,
  memory: false,
  summarization: false,
  todo: false,
  vision: false,
  autoTitle: false,
  threadData: false,
  uploads: false,
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
