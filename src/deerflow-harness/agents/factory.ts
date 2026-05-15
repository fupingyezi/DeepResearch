import { AgentMiddleware, createAgent } from 'langchain';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { StructuredToolInterface } from '@langchain/core/tools';
import { BaseCheckpointSaver } from '@langchain/langgraph';
import { ThreadStateAnnotation } from './thread-state';
import { RuntimeFeatures, DEFAULT_FEATURES } from './features';
import { AssembelOptions } from '../types';
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
  } else if (features) {
    const feat = features ? features : DEFAULT_FEATURES;
    effectiveMiddlewares = assembleFromFeatures(features, {
      planMode: opts.planMode,
      extraMiddlewares,
    }).chain;
  }

  return createAgent({
    model,
    tools,
    stateSchema: ThreadStateAnnotation,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(checkpointer ? { checkpointer } : {}),
    middleware: effectiveMiddlewares,
  });
}

export function assembleFromFeatures(
  features: RuntimeFeatures,
  options: AssembelOptions,
): { chain: AgentMiddleware[]; extraTools: StructuredToolInterface[] } {
  const { name = 'default', planMode = false, extraMiddlewares } = options;

  const chain: AgentMiddleware[] = [];
  const extraTools: StructuredToolInterface[] = [];

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
