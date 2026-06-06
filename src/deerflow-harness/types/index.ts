import { StructuredToolInterface } from '@langchain/core/tools';
import { AgentMiddleware } from 'langchain';
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
  /** nucleus sampling，建议 0.8~0.95；缺省由 provider 决定。 */
  topP?: number;
  /** 单次响应最大 token 数；强烈建议显式设置以防 repetition collapse 长尾。 */
  maxTokens?: number;
  /** 频次惩罚：>0 抑制重复 token；Qwen/OpenAI 推荐 0.3~0.6。 */
  frequencyPenalty?: number;
  /** 出现惩罚：>0 抑制重复主题；推荐 0.0~0.3。 */
  presencePenalty?: number;
}

/** 统一工具类型 — LangChain StructuredTool 即可 */
export type BaseTool = StructuredToolInterface;

export interface ClientOptions {
  /** agent 实例名称，用于区分日志 */
  agentName?: string;
  /** 是否启用长期记忆（features.memory）。默认 false。 */
  memoryEnabled?: boolean;
  /** 是否启用 autoTitle（features.autoTitle）。默认 false；服务级建议 true。 */
  autoTitleEnabled?: boolean;
  /** 是否启用 ThreadDataMiddleware（features.threadData）。默认 false；服务级建议 true。 */
  threadDataEnabled?: boolean;
  /** 是否启用 UploadsMiddleware（features.uploads）。默认 false；服务级建议 true。 */
  uploadsEnabled?: boolean;
  /** 是否启用 SandboxMiddleware + 文件工具集（features.sandbox）。默认 false；服务级建议 true。 */
  sandboxEnabled?: boolean;
  /** 是否加载并绑定 MCP 工具。默认 true。*/
  mcpEnabled?: boolean;
  /** 是否注入 task 工具与 subagent 能力（features.subagents）。默认 true。*/
  subagentsEnabled?: boolean;
  /** 可选的 user_id，用于 per-user memory 隔离；缺省走 global / per-agent。 */
  userId?: string;
  /** 可用的 skill 列表 */
  availableSkills?: string[];
}

export interface AssembelOptions {
  name?: string;
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

export * from './subagent';
