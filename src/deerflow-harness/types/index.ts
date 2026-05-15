import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { StructuredToolInterface } from '@langchain/core/tools';
import { BaseCheckpointSaver } from '@langchain/langgraph';
import { AgentMiddleware, createAgent } from 'langchain';
import { HumanMessage, ToolMessage, AIMessage } from 'langchain';

/**
 * Provider 标识。用于针对不同 OpenAI 兼容后端选择适配策略。
 */
export type ModelProvider = 'openai' | 'qwen' | 'deepseek' | 'moonshot' | 'unknown';

export interface ModelConfig {
  modelName: string;
  baseUrl?: string;
  apiKey?: string;
  provider?: ModelProvider;
  streaming?: boolean;
  temperature?: number;
}

/** 统一工具类型 — LangChain StructuredTool 即可 */
export type BaseTool = StructuredToolInterface;

export interface ClientOptions {
  /** agent 实例名称，用于区分日志 */
  agentName?: string;
  /** 是否开启 plan 模式 */
  planMode?: boolean;
  /** 是否启用子 agent */
  subagentEnabled?: boolean;
  /** 可用的 skill 列表 */
  availableSkills?: string[];
}

export interface AssembelOptions {
  name?: string;
  planMode?: boolean;
  extraMiddlewares?: AgentMiddleware[];
  /** 当前 model 的 provider，用于 feature 自动判断（如 qwenToolCallRecovery）。 */
  provider?: ModelProvider;
}

/**
 * 缓存键类型 — 用于判断 agent 是否需要重建。
 * 只有"影响 agent 形态"的参数才纳入 key。
 */
export type AgentConfigKey = string;

export type StreamEventType = 'values' | 'messages' | 'custom' | 'end';

export * from './agent-event';

export type Message = HumanMessage | ToolMessage | AIMessage | { type: string; content: string };

export interface AgentState {
  messages: Message[];
  [key: string]: any;
}
