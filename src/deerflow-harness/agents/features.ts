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
  /** VisionMiddleware（历史图片压缩）+ 注入 view_image 工具。由模型能力驱动。 */
  vision?: FeatureToggle;
  autoTitle?: FeatureToggle;
  /** ThreadDataMiddleware：beforeAgent 从 file_metadata 装载本会话上传文件到 state。 */
  threadData?: FeatureToggle;
  /** UploadsMiddleware：把 state.uploadedFiles 渲染为 SystemMessage 注入 prompt。 */
  uploads?: FeatureToggle;
  /** GuardrailMiddleware：规则式护栏（提示注入 + 敏感输出）。true=默认规则实现。 */
  guardrail?: FeatureToggle;
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

/**
 * 插入锚点：既接受中间件**类**（`@Next(LoopDetectionMiddleware)` 装饰类），
 * 也接受中间件**实例**（内置中间件多为 `createMiddleware()` 实例，如
 * `loopDetectionMiddleware`）。装配时先按同一性匹配，再退化按 `name` 匹配 ——
 * 链上内置中间件是 `createMiddleware()` 造出的普通对象（`constructor` 恒为
 * `Object`），故类锚点靠**类名与实例 `name` 相等**命中；构造函数比对只对
 * `class X extends AgentMiddleware` 形态的中间件有效。
 */
export type MiddlewareAnchor = AgentMiddleware | (new (...args: any[]) => AgentMiddleware);

export interface PositionedMiddleware extends AgentMiddleware {
  _nextAnchor?: MiddlewareAnchor;
  _prevAnchor?: MiddlewareAnchor;
}

/**
 * 标记中间件插入锚点的位置：插到 anchor 之后。
 *
 * 用法一（装饰器，锚点写在类上）：
 * ```ts
 * @Next(LoopDetectionMiddleware)
 * class MyMiddleware extends AgentMiddleware {}
 * ```
 * 用法二（实例，锚点写在实例上）：
 * ```ts
 * const middleware = createMiddleware({ name: 'MyMiddleware' });
 * Object.assign(middleware, { _nextAnchor: LoopDetectionMiddleware });
 * ```
 * 两种都经 `extraMiddlewares` 传入 `assembleFromFeatures` 生效；锚点不在链上时
 * 退化为追加链尾。
 */
export function Next(anchor: MiddlewareAnchor) {
  return function <U extends new (...args: any[]) => AgentMiddleware>(target: U): U {
    (target as PositionedMiddleware)._nextAnchor = anchor;
    return target;
  };
}

/** 标记中间件插入锚点的位置：插到 anchor 之前（用法同 {@link Next}）。 */
export function Prev(anchor: MiddlewareAnchor) {
  return function <U extends new (...args: any[]) => AgentMiddleware>(target: U): U {
    (target as PositionedMiddleware)._prevAnchor = anchor;
    return target;
  };
}

/**
 * 解析中间件的插入锚点；无锚点返回 null。
 *
 * 锚点可能写在两处：装饰器写在**类（构造函数）**上，而 `createMiddleware()`
 * 会剥离实例上的未知字段，因此先读实例字段（手工 `Object.assign` 场景），
 * 再回退构造函数静态字段（`@Next` / `@Prev` 装饰类场景）。`_prevAnchor` 优先。
 */
export function resolveMiddlewareAnchor(middleware: AgentMiddleware): {
  anchor: MiddlewareAnchor;
  side: 'prev' | 'next';
} | null {
  const positioned = middleware as PositionedMiddleware;
  if (positioned._prevAnchor) return { anchor: positioned._prevAnchor, side: 'prev' };
  if (positioned._nextAnchor) return { anchor: positioned._nextAnchor, side: 'next' };
  const ctor = middleware.constructor as unknown as PositionedMiddleware | undefined;
  if (ctor?._prevAnchor) return { anchor: ctor._prevAnchor, side: 'prev' };
  if (ctor?._nextAnchor) return { anchor: ctor._nextAnchor, side: 'next' };
  return null;
}

/** 锚点的显示名（类取类名，实例取 `name`），用于日志与签名。 */
export function anchorDisplayName(anchor: MiddlewareAnchor): string {
  if (typeof anchor === 'function') return anchor.name;
  return (anchor as { name?: string }).name ?? '(anonymous)';
}

/** 中间件的显示名，用于日志与签名。 */
export function middlewareDisplayName(middleware: AgentMiddleware): string {
  return (middleware as { name?: string }).name ?? '(anonymous)';
}
