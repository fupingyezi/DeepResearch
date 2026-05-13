import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { StructuredToolInterface } from '@langchain/core/tools';
import { BaseCheckpointSaver } from '@langchain/langgraph';
import { ThreadStateAnnotation } from './thread-state';

export interface CreateAgentOptions {
  model: BaseChatModel;
  tools?: StructuredToolInterface[];
  systemPrompt?: string;
  checkpointer?: BaseCheckpointSaver;
}

/**
 * 最小 agent 工厂 — 基于 LangGraph createReactAgent
 */
export function createBaseAgent(opts: CreateAgentOptions) {
  const { model, tools = [], systemPrompt, checkpointer } = opts;

  return createReactAgent({
    llm: model,
    tools,
    stateSchema: ThreadStateAnnotation,
    ...(systemPrompt ? { prompt: systemPrompt } : {}),
    ...(checkpointer ? { checkpointSaver: checkpointer } : {}),
  });
}
