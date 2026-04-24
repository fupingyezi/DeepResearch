/**
 * Harness 核心类型定义
 *
 * 定义 Agent Harness 运行时容器的核心类型系统，
 * 包括配置、上下文、生命周期和执行结果。
 */

import { AgentEventMetadata } from "@/types/agentEvent";
import { HarnessHook } from "./hooks";

// ============================================================
// Harness 生命周期枚举
// ============================================================

/**
 * Harness 生命周期阶段
 *
 * 每个 Agent Harness 实例都遵循 initialize → execute → cleanup 三阶段生命周期
 */
export enum HarnessLifecycle {
  /** 初始化阶段：创建 Agent 实例、绑定工具、设置上下文 */
  INITIALIZE = "initialize",
  /** 执行阶段：运行 Agent 的 ReAct 循环 */
  EXECUTE = "execute",
  /** 清理阶段：释放资源、清除上下文 */
  CLEANUP = "cleanup",
}

// ============================================================
// Harness 配置
// ============================================================

/**
 * Harness 配置接口
 *
 * 定义创建一个 Agent Harness 实例所需的全部配置信息
 */
export interface HarnessConfig {
  /** Agent 唯一标识 */
  agentId: string;
  /** Agent 系统提示词 */
  systemPrompt: string;
  /** LLM 模型配置（provider + model 名称） */
  model?: {
    provider: string;
    model: string;
    maxTokens?: number;
    temperature?: number;
  };
  /** Agent 可使用的工具列表 */
  tools?: any[];
  /** 执行超时时间（毫秒），默认 60000 */
  timeout?: number;
  /** 该 Agent 的 Hooks 配置 */
  hooks?: HarnessHook[];
  /** ReAct 循环最大迭代次数，默认 20 */
  maxIterations?: number;
  /** LangGraph checkpointer 实例（用于状态持久化） */
  checkpointer?: any;
  /** 递归限制，默认 200 */
  recursionLimit?: number;
}

// ============================================================
// Harness 上下文
// ============================================================

/**
 * Harness 执行上下文
 *
 * 每个 Agent Harness 实例拥有独立的执行上下文，
 * 确保不同 Agent 之间的状态完全隔离。
 */
export interface HarnessContext {
  /** 上下文唯一标识 */
  contextId: string;
  /** 消息历史 */
  messages: any[];
  /** 自定义状态存储 */
  state: Record<string, any>;
  /** 事件元数据（会附加到该 Harness 产生的每个事件上） */
  metadata: AgentEventMetadata;
  /** 嵌套深度（Lead Agent = 0，Sub-agent = 1，Sub-sub-agent = 2） */
  depth: number;
  /** 父 Harness 的上下文 ID（仅 Sub-agent 有值） */
  parentContextId?: string;
  /** 当前生命周期阶段 */
  lifecycle: HarnessLifecycle;
  /** 创建时间戳 */
  createdAt: number;
}

// ============================================================
// Harness 执行结果
// ============================================================

/**
 * Harness 执行结果
 *
 * 统一的执行结果格式，包含最终输出和执行指标
 */
export interface HarnessExecutionResult {
  /** 是否执行成功 */
  success: boolean;
  /** 最终文本输出 */
  output: string;
  /** 执行指标 */
  metrics: HarnessExecutionMetrics;
  /** 错误信息（失败时） */
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
}

/**
 * Harness 执行指标
 */
export interface HarnessExecutionMetrics {
  /** 执行耗时（毫秒） */
  durationMs: number;
  /** Token 使用统计 */
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
  };
  /** 工具调用次数 */
  toolCallCount: number;
  /** Sub-agent 调度次数 */
  subAgentDispatchCount: number;
}

// ============================================================
// Harness 默认配置常量
// ============================================================

/** 默认超时时间：60 秒 */
export const DEFAULT_TIMEOUT = 60_000;

/** 默认 ReAct 循环最大迭代次数 */
export const DEFAULT_MAX_ITERATIONS = 20;

/** 默认递归限制 */
export const DEFAULT_RECURSION_LIMIT = 200;

/** Sub-agent 最大嵌套深度 */
export const MAX_NESTING_DEPTH = 2;

/** Sub-agent 最大并发数 */
export const MAX_CONCURRENT_SUB_AGENTS = 5;

/** Hooks 链最大深度 */
export const MAX_HOOKS_CHAIN_DEPTH = 10;
