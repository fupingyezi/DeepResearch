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
  createSubagentLimitMiddleware,
  loopDetectionMiddleware,
  clarificationMiddleware,
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

  // 统一为所有中间件包一层调用日志（受 env MW_TRACE 控制，默认开启）。
  const wrapped = withCallLogAll(effectiveMiddlewares);
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
 * 对齐 deer-flow 2.0：lead-agent 永远启用 subagent 能力，
 * `taskTool` 与 `subagentLimitMiddleware` 始终挂载，不再受 features.subagent
 * 控制。其它能力（memory / qwen recovery）仍按 features 开关条件挂载。
 *
 * SubagentExecutor 在内部调用 createBaseAgent 时不会传 features.subagent，
 * 但 lead-agent 工具集会包含 task；为防止 subagent 内部递归调用 task，
 * 实际工具集由 task-tool 在装载 subagent 工具时按 disabledTools 过滤掉。
 *
 * 注意：SubagentExecutor 调用 createBaseAgent 时同样会走这条路径，因此
 * subagent 也会注入 task 工具到中间件链上 —— 但 task-tool 装载阶段
 * 会过滤掉 task，最终绑定到 LLM 的工具列表里没有 task，模型不会调用它。
 * subagentLimitMiddleware 在 subagent 上下文中也是无害的（不会拦到 task）。
 */
export function assembleFromFeatures(
  features: RuntimeFeatures,
  options: AssembelOptions,
): { chain: AgentMiddleware[]; extraTools: StructuredToolInterface[] } {
  const { provider } = options;

  const chain: AgentMiddleware[] = [];
  const extraTools: StructuredToolInterface[] = [];

  // [*] QwenToolCallRecoveryMiddleware
  const recoveryFeat = features.qwenToolCallRecovery;
  if (recoveryFeat === true) {
    chain.push(qwenToolCallRecoveryMiddleware);
  } else if (typeof recoveryFeat === 'object' && recoveryFeat !== null) {
    chain.push(recoveryFeat as AgentMiddleware);
  } else if (recoveryFeat === undefined && provider === 'qwen') {
    chain.push(qwenToolCallRecoveryMiddleware);
  }

  // [3] ToolCallIntegrityMiddleware (始终启用)
  //   统一处理消息层面的工具调用完整性问题（IntegrityRule 形式可插拔）。
  chain.push(toolCallIntegrityMiddleware);

  // [4] ToolErrorHandlingMiddleware (始终启用)
  chain.push(toolErrorHandlingMiddleware);

  // [8] MemoryMiddleware (features.memory)
  const memoryFeat = features.memory;
  if (memoryFeat === true) {
    chain.push(memoryMiddleware);
  } else if (typeof memoryFeat === 'object' && memoryFeat !== null) {
    chain.push(memoryFeat as AgentMiddleware);
  }

  // [10] SubagentLimitMiddleware (始终启用)
  //   lead-agent 永远具备 task 能力，必须挂上并发/总量上限兜底，
  //   防止模型 prompt 失控产生过多 task。
  //
  //   注意：必须为每个 agent 实例创建**独立的** middleware 实例 ——
  //   模块级单例会让 CounterRegistry 跨请求 / 跨 agent 共享，
  //   一旦异常路径（客户端断流、上游 promise rejection 跑到外层）
  //   导致 `inflight` 没有走到 finally 被回收，下一次请求一进来就会
  //   误报 `subagent task concurrency limit reached`。每个 agent 独立
  //   counter 后，agent 重建（cacheKey 命中重建分支）即可天然清零。
  chain.push(createSubagentLimitMiddleware());

  // [11] LoopDetectionMiddleware (始终启用)
  chain.push(loopDetectionMiddleware);

  // [12] ClarificationMiddleware (始终最后)
  chain.push(clarificationMiddleware);

  // task 工具始终注入到 lead-agent 工具集（subagent 内部由 task-tool 装载阶段过滤）
  extraTools.push(taskTool as StructuredToolInterface);

  return { chain, extraTools };
}
