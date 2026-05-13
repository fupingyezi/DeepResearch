import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { StructuredToolInterface } from '@langchain/core/tools';
import { BaseCheckpointSaver } from '@langchain/langgraph';

export interface ModelConfig {
  modelName: string;
  baseUrl?: string;
  apiKey?: string;
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

/**
 * 缓存键类型 — 用于判断 agent 是否需要重建。
 * 只有"影响 agent 形态"的参数才纳入 key。
 */
export type AgentConfigKey = string;

export type StreamEventType = 'values' | 'messages' | 'custom' | 'end';
