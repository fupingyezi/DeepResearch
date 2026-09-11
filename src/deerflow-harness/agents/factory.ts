import { AgentMiddleware, createAgent } from 'langchain';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { StructuredToolInterface } from '@langchain/core/tools';
import { BaseCheckpointSaver } from '@langchain/langgraph';
import { ThreadStateAnnotation } from './thread-state';
import {
  RuntimeFeatures,
  DEFAULT_FEATURES,
  type FeatureToggle,
  type MiddlewareAnchor,
  type PositionedMiddleware,
} from './features';
import { AssembelOptions, ModelProvider } from '../types';
import { taskTool, SANDBOX_TOOLS } from '../tools';
import {
  toolCallIntegrityMiddleware,
  toolErrorHandlingMiddleware,
  memoryMiddleware,
  todoMiddleware,
  titleMiddleware,
  threadDataMiddleware,
  uploadsMiddleware,
  sandboxMiddleware,
  viewImageMiddleware,
  createSubagentLimitMiddleware,
  loopDetectionMiddleware,
  qwenToolCallRecoveryMiddleware,
  withCallLogAll,
} from './middlewares';

export interface CreateAgentOptions {
  model: BaseChatModel;
  name?: string;
  tools?: StructuredToolInterface[];
  systemPrompt?: string;
  middlewares?: AgentMiddleware[];
  features?: RuntimeFeatures;
  extraMiddlewares?: AgentMiddleware[];
  checkpointer?: BaseCheckpointSaver;
  /** 当前 model 的 provider，用于按 provider 自动启用相关中间件。 */
  provider?: ModelProvider;
}

export function createBaseAgent(opts: CreateAgentOptions) {
  const {
    model,
    tools = [],
    systemPrompt,
    checkpointer,
    middlewares,
    extraMiddlewares,
    features,
    provider,
  } = opts;

  if (middlewares && features) {
    throw new Error('Cannot specify both middlewares and features');
  }

  if (middlewares && extraMiddlewares) {
    throw new Error('Cannot specify middlewares with extraMiddlewares');
  }

  let effectiveMiddlewares: AgentMiddleware[] = [];
  let effectiveTools: StructuredToolInterface[] = tools;

  if (middlewares) {
    effectiveMiddlewares = middlewares;
  } else {
    const feat = features ? features : DEFAULT_FEATURES;
    const { chain, extraTools } = assembleFromFeatures(feat, {
      extraMiddlewares,
      provider,
    });
    effectiveMiddlewares = chain;
    if (extraTools.length > 0) {
      // 去重合并：按工具 name，避免 caller 已显式传入同名工具时重复注册
      const seen = new Set<string>();
      effectiveTools = [];
      for (const t of [...tools, ...extraTools]) {
        const n = (t as { name?: string }).name;
        if (n && seen.has(n)) continue;
        if (n) seen.add(n);
        effectiveTools.push(t);
      }
    }
  }

  // 统一为所有中间件包一层调用日志（受 env MW_TRACE 控制，默认关闭）。
  const wrapped = withCallLogAll(effectiveMiddlewares);
  if (process.env.MW_TRACE === '1' || process.env.MW_TRACE === 'true') {
    console.log(
      `[mw] decorated ${wrapped.length} middleware(s): ${wrapped
        .map((m) => (m as { name?: string }).name ?? '?')
        .join(', ')}`,
    );
    console.log(
      `[agent] tools bound to LLM (${effectiveTools.length}): ${effectiveTools
        .map((t) => (t as { name?: string }).name ?? '?')
        .join(', ')}`,
    );
  }

  return createAgent({
    model,
    tools: effectiveTools,
    stateSchema: ThreadStateAnnotation,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(checkpointer ? { checkpointer } : {}),
    middleware: wrapped,
  });
}

/**
 * 装配中间件链与 lead-agent 内置 extra tools。
 *
 * lead-agent 永远启用 subagent 能力：`taskTool` 与 `subagentLimitMiddleware`
 * 始终挂载。其它能力（memory / qwen recovery / threadData / uploads / title /
 * vision）按 features 开关条件挂载。
 *
 * 装配顺序严格按 `middlewares/index.ts` 中 ORDERED_MIDDLEWARES 编排：
 *   threadData(0) → uploads(1) → sandbox(2 features.sandbox) → toolCallIntegrity(3) →
 *   guardrail(4 暂未挂) → toolErrorHandling(5) → summarization(6) → todo(7) →
 *   title(8) → memory(9) → viewImage(10) → subagentLimit(11) → loopDetection(12)
 *
 * SubagentExecutor 内部调用 createBaseAgent 时显式传入 `SUBAGENT_FEATURES`
 * （`subagents: false`），因此装配层不会注入 task 工具，也不会挂
 * subagentLimitMiddleware —— 防递归由「工具可见性」硬保证：子 agent 的 LLM
 * 工具列表里根本没有 task（system prompt 约束与用量限额仅作兜底）。
 */
export function assembleFromFeatures(
  features: RuntimeFeatures,
  options: AssembelOptions,
): { chain: AgentMiddleware[]; extraTools: StructuredToolInterface[] } {
  const { provider, extraMiddlewares } = options;

  const chain: AgentMiddleware[] = [];
  const extraTools: StructuredToolInterface[] = [];

  // QwenToolCallRecoveryMiddleware：feature 启用，或 provider=qwen 时自动启用
  // 编排上不在 ORDERED_MIDDLEWARES 内（mini 特有），保持在最前以最早处理 qwen
  // 工具调用流式残片。
  const recoveryFeat = features.qwenToolCallRecovery;
  if (recoveryFeat === true) {
    chain.push(qwenToolCallRecoveryMiddleware);
  } else if (typeof recoveryFeat === 'object' && recoveryFeat !== null) {
    chain.push(recoveryFeat as AgentMiddleware);
  } else if (recoveryFeat === undefined && provider === 'qwen') {
    chain.push(qwenToolCallRecoveryMiddleware);
  }

  // (0) ThreadDataMiddleware：beforeAgent 装载 state.uploadedFiles。
  pushFeature(chain, features.threadData, threadDataMiddleware);

  // (1) UploadsMiddleware：beforeAgent 把 uploadedFiles 注入 SystemMessage。
  // 必须排在 threadData 之后；运行期顺序由本数组顺序决定。
  pushFeature(chain, features.uploads, uploadsMiddleware);

  // (2) SandboxMiddleware：beforeAgent 获取/复用沙箱并写回 state.sandbox。
  // 开启时把 7 个文件工具注入 lead-agent 工具集（subagent 经工具注册表继承）。
  if (features.sandbox === true) {
    chain.push(sandboxMiddleware);
    for (const t of SANDBOX_TOOLS) extraTools.push(t as StructuredToolInterface);
  } else if (typeof features.sandbox === 'object' && features.sandbox !== null) {
    chain.push(features.sandbox);
    for (const t of SANDBOX_TOOLS) extraTools.push(t as StructuredToolInterface);
  }

  // (3) 始终启用：消息层面的工具调用完整性（IntegrityRule 形式可插拔）
  chain.push(toolCallIntegrityMiddleware);

  // (5) 始终启用：工具自身执行异常的兜底
  chain.push(toolErrorHandlingMiddleware);

  // (6) 可选：历史摘要（features.summarization 不允许 true，须传 createSummarizationMiddleware 实例）
  const summarizationFeat = features.summarization;
  if (typeof summarizationFeat === 'object' && summarizationFeat !== null) {
    chain.push(summarizationFeat as AgentMiddleware);
  }

  // (7) 可选：todo 规划（现成 todoListMiddleware）
  const todoFeat = features.todo;
  if (todoFeat === true) {
    chain.push(todoMiddleware);
  } else if (typeof todoFeat === 'object' && todoFeat !== null) {
    chain.push(todoFeat as AgentMiddleware);
  }

  // (8) 可选：autoTitle —— afterAgent 生成会话标题并落库。
  pushFeature(chain, features.autoTitle, titleMiddleware);

  // (9) 可选：长期记忆
  const memoryFeat = features.memory;
  if (memoryFeat === true) {
    chain.push(memoryMiddleware);
  } else if (typeof memoryFeat === 'object' && memoryFeat !== null) {
    chain.push(memoryFeat as AgentMiddleware);
  }

  // (10) 可选：viewImage —— 当前为占位实现（仅启用时打印一次警告）。
  pushFeature(chain, features.vision, viewImageMiddleware);

  // (11) subagent 频次/并发上限。每个 agent 实例独立 counter——
  // 仅在启用 subagents 时挂载（features.subagents !== false，默认启用）。
  const subagentsEnabled = features.subagents !== false;
  if (subagentsEnabled) {
    chain.push(createSubagentLimitMiddleware());
  }

  // (12) 始终启用：循环检测
  chain.push(loopDetectionMiddleware);

  // task 工具按开关注入到 lead-agent 工具集；subagent 走 SUBAGENT_FEATURES
  // （subagents=false），此处不注入 task，构成防递归硬保证。
  if (subagentsEnabled) {
    extraTools.push(taskTool as StructuredToolInterface);
  }

  // 自定义中间件：按 @Next/@Prev 锚点插入（无锚点 / 锚点未命中 → 追加到链尾）
  for (const middleware of extraMiddlewares ?? []) {
    insertWithAnchor(chain, middleware);
  }

  return { chain, extraTools };
}

/**
 * 按 `@Next` / `@Prev` 装饰器声明的锚点，把自定义中间件插入链中。
 *
 * 锚点读取：装饰器把锚点写在**类（构造函数）**上，而 `createMiddleware()`
 * 会剥离实例上的未知字段，因此两个位置都要读 —— 优先实例字段（手工
 * `Object.assign` 场景），回退构造函数静态字段（`@Next` / `@Prev` 装饰类场景）。
 *
 * 匹配规则：
 * - 优先按构造函数同一性匹配；生产构建可能压缩类名，退化到 `name` 相等；
 * - `_prevAnchor` 插入到**第一个**匹配实例之前；`_nextAnchor` 插入到
 *   **最后一个**匹配实例之后（同名中间件可能在链上出现多次）；
 * - 无锚点或锚点不在链上时追加到链尾（保持历史语义）。
 */
function insertWithAnchor(chain: AgentMiddleware[], middleware: AgentMiddleware): void {
  const resolved = resolveAnchor(middleware);
  if (!resolved) {
    chain.push(middleware);
    return;
  }
  const { anchor, side } = resolved;

  const matches = chain
    .map((existing, index) => ({ existing, index }))
    .filter(({ existing }) => matchesAnchor(existing, anchor));

  if (matches.length === 0) {
    chain.push(middleware);
    return;
  }

  if (side === 'prev') {
    chain.splice(matches[0].index, 0, middleware);
  } else {
    chain.splice(matches[matches.length - 1].index + 1, 0, middleware);
  }
}

/** 解析中间件的插入锚点；无锚点返回 null。 */
function resolveAnchor(
  middleware: AgentMiddleware,
): { anchor: MiddlewareAnchor; side: 'prev' | 'next' } | null {
  const positioned = middleware as PositionedMiddleware;
  if (positioned._prevAnchor) return { anchor: positioned._prevAnchor, side: 'prev' };
  if (positioned._nextAnchor) return { anchor: positioned._nextAnchor, side: 'next' };
  // 装饰器把锚点写在类（构造函数）上，而 createMiddleware 会剥离实例未知字段，
  // 因此再回退读一次构造函数的静态字段。
  const ctor = middleware.constructor as unknown as PositionedMiddleware | undefined;
  if (ctor?._prevAnchor) return { anchor: ctor._prevAnchor, side: 'prev' };
  if (ctor?._nextAnchor) return { anchor: ctor._nextAnchor, side: 'next' };
  return null;
}

/** 判断链上中间件是否命中锚点：锚点为类时比构造函数，为实例时先同一性再比 name。 */
function matchesAnchor(existing: AgentMiddleware, anchor: MiddlewareAnchor): boolean {
  if (existing === anchor) return true;
  if (typeof anchor === 'function') {
    return (
      existing.constructor === anchor ||
      (existing.constructor as { name?: string } | undefined)?.name === anchor.name
    );
  }
  return (existing as { name?: string }).name === (anchor as { name?: string }).name;
}

/**
 * features 三态装配辅助：
 * - `true`     → 挂默认 middleware；
 * - 对象实例   → 挂自定义 middleware；
 * - 其它       → 跳过。
 */
function pushFeature(
  chain: AgentMiddleware[],
  feat: FeatureToggle | undefined,
  defaultMw: AgentMiddleware,
): void {
  if (feat === true) {
    chain.push(defaultMw);
  } else if (typeof feat === 'object' && feat !== null) {
    chain.push(feat);
  }
}
