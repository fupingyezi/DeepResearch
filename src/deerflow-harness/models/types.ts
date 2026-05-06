/**
 * LLM 模块类型定义
 *
 * 基于反射配置的 Model Factory 类型系统。
 * 通过配置文件声明模型，运行时动态加载。
 *
 * @module lib/llm/types
 */

/**
 * 模型配置接口
 *
 * 声明一个 LLM 模型的完整配置信息，包括模块路径、认证信息、默认参数等。
 *
 * @example
 * ```typescript
 * const config: ModelConfig = {
 *   name: "qwen-plus",
 *   use: "@langchain/openai:ChatOpenAI",
 *   model: "qwen-plus",
 *   apiKey: "$OPENAI_QWEN_API_KEY",
 *   baseURL: "$OPENAI_QWEN_BASE_URL",
 *   patches: ["dashscope-toolcall-fix"],
 * };
 * ```
 */
export interface ModelConfig {
  /** 模型唯一标识名称 */
  name: string;
  /** LangChain 模型类的模块路径，格式为 "module:ClassName"（如 "@langchain/openai:ChatOpenAI"） */
  use: string;
  /** 实际模型名称（如 "qwen-plus"、"gpt-4-turbo-preview"） */
  model: string;
  /** API Key，支持 "$ENV_VAR_NAME" 格式引用环境变量 */
  apiKey: string;
  /** API 基础 URL，支持 "$ENV_VAR_NAME" 格式引用环境变量 */
  baseURL?: string;
  /** 是否支持思考模式（reasoning/thinking） */
  supports_thinking?: boolean;
  /** 启用思考模式时的额外参数，会合并到模型实例化参数中 */
  when_thinking_enabled?: Record<string, any>;
  /** 额外的模型参数（会合并到请求体的 modelKwargs 中） */
  modelKwargs?: Record<string, any>;
  /** 需要应用的补丁列表（如 ["dashscope-toolcall-fix"]） */
  patches?: string[];
  /** 默认最大 token 数 */
  defaultMaxTokens?: number;
  /** 默认温度 */
  defaultTemperature?: number;
  /** 默认超时时间（毫秒） */
  defaultTimeout?: number;
}

/**
 * 创建模型时的运行时选项
 *
 * 运行时传入的参数会覆盖配置文件中的默认值。
 */
export interface CreateModelOptions {
  /** 是否启用思考模式 */
  thinkingEnabled?: boolean;
  /** 覆盖模型名称 */
  model?: string;
  /** 最大 token 数 */
  maxTokens?: number;
  /** 模型温度，控制输出随机性，0~1 */
  temperature?: number;
  /** 超时时间（毫秒） */
  timeout?: number;
  /** 是否采用流式响应 */
  streaming?: boolean;
  /** 额外的模型参数（会合并到请求体中） */
  modelKwargs?: Record<string, any>;
}

/**
 * 模型解析错误
 *
 * 当动态 import 模块失败或目标类不存在时抛出。
 */
export class ModelResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelResolveError";
  }
}

/**
 * 模型未找到错误
 *
 * 当请求的模型名称在配置中不存在时抛出。
 */
export class ModelNotFoundError extends Error {
  constructor(modelName: string) {
    super(`模型 "${modelName}" 在配置中未找到。请检查 models.config.ts 中是否已声明该模型。`);
    this.name = "ModelNotFoundError";
  }
}

/**
 * 配置错误
 *
 * 当配置验证失败（如环境变量缺失、格式错误）时抛出。
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}
