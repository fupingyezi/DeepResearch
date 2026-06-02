import { AgentMiddleware, createAgent } from 'langchain';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { StructuredToolInterface } from '@langchain/core/tools';
import { BaseCheckpointSaver } from '@langchain/langgraph';
import { ThreadStateAnnotation } from './thread-state';
import { RuntimeFeatures, DEFAULT_FEATURES } from './features';
import { AssembelOptions, ModelProvider } from '../types';
import { taskTool } from '../tools';
import {
  toolCallIntegrityMiddleware,
  toolErrorHandlingMiddleware,
  memoryMiddleware,
  todoMiddleware,
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
 * 始终挂载。其它能力（memory / qwen recovery）按 features 开关条件挂载。
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
  const recoveryFeat = features.qwenToolCallRecovery;
  if (recoveryFeat === true) {
    chain.push(qwenToolCallRecoveryMiddleware);
  } else if (typeof recoveryFeat === 'object' && recoveryFeat !== null) {
    chain.push(recoveryFeat as AgentMiddleware);
  } else if (recoveryFeat === undefined && provider === 'qwen') {
    chain.push(qwenToolCallRecoveryMiddleware);
  }

  // 始终启用：消息层面的工具调用完整性（IntegrityRule 形式可插拔）
  chain.push(toolCallIntegrityMiddleware);

  // 始终启用：工具自身执行异常的兜底
  chain.push(toolErrorHandlingMiddleware);

  // 可选：历史摘要（features.summarization 不允许 true，须传 createSummarizationMiddleware 实例）
  const summarizationFeat = features.summarization;
  if (typeof summarizationFeat === 'object' && summarizationFeat !== null) {
    chain.push(summarizationFeat as AgentMiddleware);
  }

  // 可选：todo 规划（现成 todoListMiddleware）
  const todoFeat = features.todo;
  if (todoFeat === true) {
    chain.push(todoMiddleware);
  } else if (typeof todoFeat === 'object' && todoFeat !== null) {
    chain.push(todoFeat as AgentMiddleware);
  }

  // 可选：长期记忆
  const memoryFeat = features.memory;
  if (memoryFeat === true) {
    chain.push(memoryMiddleware);
  } else if (typeof memoryFeat === 'object' && memoryFeat !== null) {
    chain.push(memoryFeat as AgentMiddleware);
  }

  // 始终启用：subagent 频次/并发上限。每个 agent 实例独立 counter——
  // 模块级单例会让 CounterRegistry 跨请求共享，异常路径下 inflight 不
  // 回收会导致下次请求误报"concurrency limit reached"。
  chain.push(createSubagentLimitMiddleware());

  // 始终启用：循环检测
  chain.push(loopDetectionMiddleware);

  // task 工具始终注入到 lead-agent 工具集（subagent 内部由 task-tool 装载阶段过滤）
  extraTools.push(taskTool as StructuredToolInterface);

  return { chain, extraTools };
}
