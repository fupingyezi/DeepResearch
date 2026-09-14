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
  resolveMiddlewareAnchor,
  anchorDisplayName,
  middlewareDisplayName,
} from './features';
import { AssembelOptions, ModelProvider } from '../types';
import { taskTool, SANDBOX_TOOLS, viewImageTool } from '../tools';
import { visionMiddleware } from '../vision';
import {
  toolCallIntegrityMiddleware,
  toolErrorHandlingMiddleware,
  memoryMiddleware,
  todoMiddleware,
  titleMiddleware,
  threadDataMiddleware,
  uploadsMiddleware,
  sandboxMiddleware,
  createSubagentLimitMiddleware,
  createGuardrailMiddleware,
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
 *   guardrail(4 features.guardrail) → toolErrorHandling(5) → summarization(6) → todo(7) →
 *   title(8) → memory(9) → vision(10) → subagentLimit(11) → loopDetection(12)
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

  // (4) 可选：规则式护栏。features.guardrail=true 走默认实现（createGuardrailMiddleware），
  // 或传入自定义中间件实例。默认关闭（库级安全默认），服务级由 _service.ts 开启。
  const guardrailFeat = features.guardrail;
  if (guardrailFeat === true) {
    chain.push(createGuardrailMiddleware());
  } else if (typeof guardrailFeat === 'object' && guardrailFeat !== null) {
    chain.push(guardrailFeat as AgentMiddleware);
  }

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

  // (10) 可选：vision —— 历史图片压缩（把历史 image_url blocks 换成文本占位，
  // 避免 base64 每轮重进 checkpoint 与重复付 vision token）。压缩先于摘要的
  // 顺序保证见 vision/vision-middleware.ts 头部注释。
  pushFeature(chain, features.vision, visionMiddleware);

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

  // view_image 工具随 features.vision 注入（与历史压缩中间件同门：模型能看图才有意义）。
  // 判据与 pushFeature 一致：true=默认启用，对象=自定义实现也算启用。
  // 子 agent 走 SUBAGENT_FEATURES（vision=false），故两者都拿不到。
  if (
    features.vision === true ||
    (typeof features.vision === 'object' && features.vision !== null)
  ) {
    extraTools.push(viewImageTool as StructuredToolInterface);
  }

  // 自定义中间件：按 @Next/@Prev 锚点插入（无锚点 / 锚点未命中 → 追加到链尾）
  insertExtrasWithAnchors(chain, extraMiddlewares ?? []);

  return { chain, extraTools };
}

/**
 * 按 `@Next` / `@Prev` 装饰器声明的锚点，把自定义中间件批量插入链中。
 *
 * 两阶段插入：先对**插入前的链快照**解析全部落位坐标，再按坐标统一 splice。
 * 若逐个插入，每次 splice 都改变链长，后续锚点匹配与坐标都会受先前插入的
 * extra 干扰——两个 `@Next(X)` 会逆序落成 `[X, B, A]`。快照语义同时明确了
 * 「extra 不能锚定另一个 extra」：extras 只对内置链解析锚点。
 *
 * 匹配规则（与单插入时期一致）：
 * - `_prevAnchor` 插入到**第一个**匹配实例之前；`_nextAnchor` 插入到
 *   **最后一个**匹配实例之后（同名中间件可能在链上出现多次）；
 * - 无锚点或锚点不在链上时追加到链尾，后者额外告警一次。
 */
function insertExtrasWithAnchors(chain: AgentMiddleware[], extras: AgentMiddleware[]): void {
  if (extras.length === 0) return;

  // 阶段一：无锚 / 未命中 → 尾坐标（与显式尾坐标在阶段二同序处理）
  const plans = extras.map((middleware, order) => {
    const resolved = resolveMiddlewareAnchor(middleware);
    let index = chain.length;
    if (resolved) {
      const matches: number[] = [];
      chain.forEach((existing, i) => {
        if (matchesAnchor(existing, resolved.anchor)) matches.push(i);
      });
      if (matches.length === 0) {
        warnAnchorMiss(middleware, resolved.anchor);
      } else {
        index = resolved.side === 'prev' ? matches[0] : matches[matches.length - 1] + 1;
      }
    }
    return { middleware, index, order };
  });

  // 阶段二：快照坐标升序 + extraMiddlewares 数组序决胜（不依赖 sort 稳定性）；
  // 累计偏移补偿先前插入对坐标的推移。同坐标（含尾坐标）按数组序先后落位。
  const ordered = plans.sort((a, b) => a.index - b.index || a.order - b.order);
  let offset = 0;
  for (const plan of ordered) {
    chain.splice(plan.index + offset, 0, plan.middleware);
    offset += 1;
  }
}

/**
 * 锚点未命中告警（同「中间件名 + 锚点名」只告警一次）。
 *
 * 「锚点不在链上 → 追加链尾」的静默降级会让顺序问题变成无报错的玄学行为，
 * 所以这里必须出声；但 `memoryEnabled=true` 时 agent 每轮重建（见 client.ts
 * 的缓存键例外），不去重就会按轮次刷屏，故按 key 只报一次。
 */
const warnedAnchorMisses = new Set<string>();

function warnAnchorMiss(middleware: AgentMiddleware, anchor: MiddlewareAnchor): void {
  const mwName = middlewareDisplayName(middleware);
  const anchorName = anchorDisplayName(anchor);
  const key = `${mwName}|${anchorName}`;
  if (warnedAnchorMisses.has(key)) return;
  warnedAnchorMisses.add(key);
  console.warn(
    `[mw] 锚点未命中：${mwName} 声明的锚点 ${anchorName} 不在链上，已退化为追加链尾。` +
      `常见原因：锚点对应的 feature 未开启，或锚点传了类名而链上是 createMiddleware 实例`,
  );
}

/**
 * 判断链上中间件是否命中锚点：锚点为类时比构造函数（再退化比构造函数名、
 * 中间件 `name`），为实例时先同一性再比 `name`。
 *
 * 第三条（`existing.name === anchor.name`）不可省：链上内置中间件都是
 * `createMiddleware()` 造出的普通对象，`constructor` 恒为 `Object`，类锚点
 * 若不比 `name` 就永远匹配不上，会静默退化成追加链尾。
 */
function matchesAnchor(existing: AgentMiddleware, anchor: MiddlewareAnchor): boolean {
  if (existing === anchor) return true;
  if (typeof anchor === 'function') {
    return (
      existing.constructor === anchor ||
      (existing.constructor as { name?: string } | undefined)?.name === anchor.name ||
      (existing as { name?: string }).name === anchor.name
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
