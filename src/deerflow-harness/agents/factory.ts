import { AgentMiddleware, createAgent } from 'langchain';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { StructuredToolInterface } from '@langchain/core/tools';
import { BaseCheckpointSaver } from '@langchain/langgraph';
import { ThreadStateAnnotation } from './thread-state';
import { RuntimeFeatures, DEFAULT_FEATURES } from './features';
import { AssembelOptions, ModelProvider } from '../types';
import {
  threadDataMiddleware,
  uploadsMiddleware,
  sandboxMiddleware,
  danglingToolCallMiddleware,
  guardrailMiddleware,
  toolErrorHandlingMiddleware,
  summarizationMiddleware,
  todoMiddleware,
  titleMiddleware,
  memoryMiddleware,
  viewImageMiddleware,
  subagentLimitMiddleware,
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
  planMode?: boolean;
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

  if (middlewares) {
    effectiveMiddlewares = middlewares;
  } else {
    const feat = features ? features : DEFAULT_FEATURES;
    effectiveMiddlewares = assembleFromFeatures(feat, {
      planMode: opts.planMode,
      extraMiddlewares,
      provider,
    }).chain;
  }

  // 统一为所有中间件包一层调用日志（受 env MW_TRACE 控制，默认开启）。
  const wrapped = withCallLogAll(effectiveMiddlewares);
  console.log(
    `[mw] decorated ${wrapped.length} middleware(s): ${wrapped
      .map((m) => (m as { name?: string }).name ?? '?')
      .join(', ')}`,
  );

  return createAgent({
    model,
    tools,
    stateSchema: ThreadStateAnnotation,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(checkpointer ? { checkpointer } : {}),
    middleware: wrapped,
  });
}

export function assembleFromFeatures(
  features: RuntimeFeatures,
  options: AssembelOptions,
): { chain: AgentMiddleware[]; extraTools: StructuredToolInterface[] } {
  const { name = 'default', planMode = false, extraMiddlewares, provider } = options;

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

  // [3] DanglingToolCallMiddleware (始终启用)
  chain.push(danglingToolCallMiddleware);

  // [5] ToolErrorHandlingMiddleware (始终启用)
  chain.push(toolErrorHandlingMiddleware);

  // [12] LoopDetectionMiddleware (始终启用)
  chain.push(loopDetectionMiddleware);

  // [13] ClarificationMiddleware (始终最后)
  chain.push(clarificationMiddleware);

  return { chain, extraTools };
}
