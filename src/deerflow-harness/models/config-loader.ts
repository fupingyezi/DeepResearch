/**
 * 配置加载与验证
 *
 * 在启动时验证模型配置的完整性和正确性，
 * 尽早发现配置错误。
 *
 * @module lib/llm/configLoader
 */

import { modelConfigs } from "./models.config";
import { checkEnvExists } from "./resolve-env";
import { ConfigurationError, ModelConfig } from "./types";

/**
 * 验证 "module:ClassName" 格式
 */
function isValidClassPath(use: string): boolean {
  const colonIndex = use.lastIndexOf(":");
  if (colonIndex === -1) return false;
  const modulePath = use.slice(0, colonIndex);
  const className = use.slice(colonIndex + 1);
  return modulePath.length > 0 && className.length > 0;
}

/**
 * 验证单个模型配置
 *
 * @param config - 模型配置
 * @param index - 配置在数组中的索引（用于错误信息）
 */
function validateModelConfig(config: ModelConfig, index: number): void {
  // 验证必填字段
  if (!config.name) {
    throw new ConfigurationError(
      `模型配置 [${index}] 缺少必填字段 "name"。`,
    );
  }
  if (!config.use) {
    throw new ConfigurationError(
      `模型配置 "${config.name}" 缺少必填字段 "use"。`,
    );
  }
  if (!config.model) {
    throw new ConfigurationError(
      `模型配置 "${config.name}" 缺少必填字段 "model"。`,
    );
  }

  // 验证 use 字段格式
  if (!isValidClassPath(config.use)) {
    throw new ConfigurationError(
      `模型配置 "${config.name}" 的 "use" 字段格式错误："${config.use}"。` +
        `期望格式为 "module:ClassName"（如 "@langchain/openai:ChatOpenAI"）。`,
    );
  }
}

/**
 * 加载并验证所有模型配置
 *
 * 在应用启动时调用，执行以下检查：
 * 1. 验证每个模型的必填字段（name、use、model）
 * 2. 验证 use 字段格式
 * 3. 检查环境变量是否存在（仅警告，不阻止启动）
 * 4. 输出已注册模型列表
 *
 * @throws ConfigurationError 如果必填字段缺失或格式错误
 */
export function loadAndValidateConfig(): void {
  if (!modelConfigs || modelConfigs.length === 0) {
    throw new ConfigurationError(
      "模型配置列表为空。请在 models.config.ts 中声明至少一个模型。",
    );
  }

  // 检查名称唯一性
  const nameSet = new Set<string>();
  for (const config of modelConfigs) {
    if (nameSet.has(config.name)) {
      throw new ConfigurationError(
        `模型配置名称重复："${config.name}"。每个模型的 name 字段必须唯一。`,
      );
    }
    nameSet.add(config.name);
  }

  // 逐个验证
  modelConfigs.forEach((config, index) => {
    validateModelConfig(config, index);

    // 检查环境变量（仅警告）
    checkEnvExists(config.apiKey);
    if (config.baseURL) {
      checkEnvExists(config.baseURL);
    }
  });

  // 输出已注册模型列表
  const modelNames = modelConfigs.map((c) => c.name).join(", ");
  console.log(`[LLM Config] 已注册 ${modelConfigs.length} 个模型：${modelNames}`);
}
