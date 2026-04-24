/**
 * Sub-agent 类型定义
 *
 * 定义 Sub-agent 的声明式配置接口和注册表接口，
 * 支持通过配置文件定义 Sub-agent，无需修改核心代码。
 */

import { HarnessHook } from "./hooks";

// ============================================================
// Sub-agent 配置
// ============================================================

/**
 * Sub-agent 声明式配置接口
 *
 * 新增一个 Sub-agent 只需创建一个实现此接口的配置文件，
 * 系统会自动将其注册并包装为 Lead Agent 可调用的 Tool。
 */
export interface SubAgentConfig {
  /** Sub-agent 唯一标识名称（必选） */
  name: string;
  /**
   * Sub-agent 用途描述（必选）
   * 此描述会作为 Tool 的 description，供 Lead Agent 的 LLM 判断调用时机
   */
  description: string;
  /** Sub-agent 执行时的系统提示词（必选） */
  systemPrompt: string;
  /**
   * Sub-agent 使用的 LLM 模型配置（可选）
   * 不指定时继承 Lead Agent 的模型配置
   */
  model?: {
    provider: string;
    model: string;
    maxTokens?: number;
    temperature?: number;
  };
  /** Sub-agent 可使用的工具列表（可选） */
  tools?: any[];
  /** 执行超时时间（毫秒），默认 60000 */
  timeout?: number;
  /** 该 Sub-agent 专属的 Hooks 配置（可选） */
  hooks?: HarnessHook[];
}

// ============================================================
// Sub-agent 注册表接口
// ============================================================

/**
 * Sub-agent 注册表接口
 *
 * 管理所有已注册的 Sub-agent 配置，
 * 支持动态注册/注销和工具化转换。
 */
export interface ISubAgentRegistry {
  /**
   * 注册一个 Sub-agent 配置
   * @param config Sub-agent 配置
   */
  register(config: SubAgentConfig): void;

  /**
   * 注销一个 Sub-agent
   * @param name Sub-agent 名称
   */
  unregister(name: string): void;

  /**
   * 获取指定名称的 Sub-agent 配置
   * @param name Sub-agent 名称
   * @returns Sub-agent 配置，不存在时返回 undefined
   */
  get(name: string): SubAgentConfig | undefined;

  /**
   * 获取所有已注册的 Sub-agent 配置
   * @returns Sub-agent 配置数组
   */
  getAll(): SubAgentConfig[];

  /**
   * 将所有已注册的 Sub-agent 转换为 LangChain Tool 数组
   *
   * 每个 Sub-agent 会被包装为一个 DynamicStructuredTool，
   * Lead Agent 可通过 function calling 调用这些 Tool 来调度 Sub-agent。
   *
   * @returns LangChain Tool 数组
   */
  toTools(): any[];
}
