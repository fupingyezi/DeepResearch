import { AgentMiddleware, createAgent } from 'langchain';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { StructuredToolInterface } from '@langchain/core/tools';
import { BaseCheckpointSaver } from '@langchain/langgraph';
import { ThreadStateAnnotation } from './thread-state';
import { RuntimeFeatures, DEFAULT_FEATURES, type FeatureToggle } from './features';
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
 * SubagentExecutor 内部调用 createBaseAgent 时同样会走这条路径，因此
 * subagent 也会注入 task 工具到中间件链上 —— 但 task-tool 装载阶段
 * 会过滤掉 task，最终绑定到 LLM 的工具列表里没有 task，模型不会调用它。
 * subagentLimitMiddleware 在 subagent 上下文中无害（不会拦到 task）。
 */
export function assembleFromFeatures(
  features: RuntimeFeatures,
  options: AssembelOptions,
): { chain: AgentMiddleware[]; extraTools: StructuredToolInterface[] } {
  const { provider } = options;

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

  // task 工具按开关注入到 lead-agent 工具集（subagent 内部由 task-tool 装载阶段过滤）。
  // 关闭 subagents 时不注入 task
  if (subagentsEnabled) {
    extraTools.push(taskTool as StructuredToolInterface);
  }

  return { chain, extraTools };
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
