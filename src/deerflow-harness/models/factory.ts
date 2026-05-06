/**
 * Model Factory 核心函数
 *
 * 通过配置文件和反射机制创建 LLM 模型实例。
 * 这是新架构的主入口，替代旧的 buildLLM() 函数。
 *
 * @module lib/llm/factory
 */

import { ModelConfig, CreateModelOptions, ModelNotFoundError } from "./types";
import { modelConfigs } from "./models.config";
import { resolveEnvValue } from "./resolve-env";
import { resolveClass } from "./class-resolver";
import { applyPatches } from "./patches";

/**
 * 根据名称查找模型配置
 */
function getModelConfig(name: string): ModelConfig | undefined {
  return modelConfigs.find((config) => config.name === name);
}

/**
 * 创建 LLM 模型实例
 *
 * 从配置文件读取模型定义，通过反射动态加载模型类并实例化。
 * 支持运行时参数覆盖、Thinking 模式条件注入、补丁应用等功能。
 *
 * @param name - 模型配置名称（对应 models.config.ts 中的 name 字段）
 * @param options - 运行时选项，会覆盖配置中的默认值
 * @returns LangChain BaseChatModel 实例
 * @throws ModelNotFoundError 如果模型名称在配置中不存在
 * @throws ConfigurationError 如果环境变量缺失
 * @throws ModelResolveError 如果模型类无法加载
 *
 * @example
 * ```typescript
 * // 基本用法
 * const model = await createChatModel("qwen");
 *
 * // 带运行时选项
 * const model = await createChatModel("qwen", {
 *   model: "qwen-turbo",
 *   streaming: true,
 *   temperature: 0.5,
 * });
 *
 * // 启用思考模式
 * const model = await createChatModel("qwen", { thinkingEnabled: true });
 * ```
 */
export async function createChatModel(
  name: string,
  options?: CreateModelOptions,
): Promise<any> {
  // 1. 查找模型配置
  const config = getModelConfig(name);
  if (!config) {
    throw new ModelNotFoundError(name);
  }

  // 2. 解析环境变量
  const apiKey = resolveEnvValue(config.apiKey);
  const baseURL = config.baseURL ? resolveEnvValue(config.baseURL) : undefined;

  // 3. 动态加载模型类
  const ModelClass = await resolveClass(config.use);

  // 4. 构建 modelKwargs
  let modelKwargs: Record<string, any> = { ...config.modelKwargs };

  // 5. 处理 Thinking 模式
  if (options?.thinkingEnabled && config.supports_thinking && config.when_thinking_enabled) {
    // 启用思考模式时，合并 when_thinking_enabled 配置
    modelKwargs = { ...modelKwargs, ...config.when_thinking_enabled };
  }

  // 合并运行时 modelKwargs
  if (options?.modelKwargs) {
    modelKwargs = { ...modelKwargs, ...options.modelKwargs };
  }

  // 6. 构建实例化参数（运行时 options 优先级高于配置默认值）
  const instanceParams: Record<string, any> = {
    model: options?.model ?? config.model,
    apiKey,
    maxTokens: options?.maxTokens ?? config.defaultMaxTokens,
    temperature: options?.temperature ?? config.defaultTemperature,
    timeout: options?.timeout ?? config.defaultTimeout,
    streaming: options?.streaming,
    modelKwargs: Object.keys(modelKwargs).length > 0 ? modelKwargs : undefined,
  };

  // 7. 处理 baseURL（ChatOpenAI 使用 configuration.baseURL 格式）
  if (baseURL) {
    instanceParams.configuration = { baseURL };
  }

  // 8. 移除 undefined 值，避免覆盖模型类的默认值
  for (const key of Object.keys(instanceParams)) {
    if (instanceParams[key] === undefined) {
      delete instanceParams[key];
    }
  }

  // 9. 实例化模型
  const model = new ModelClass(instanceParams);

  // 10. 应用补丁
  if (config.patches && config.patches.length > 0) {
    return applyPatches(model, config.patches);
  }

  return model;
}
