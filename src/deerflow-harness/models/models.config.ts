/**
 * 模型配置文件
 *
 * 以声明式方式定义所有可用的 LLM 模型。
 * 新增模型只需在此文件中添加配置项，无需修改任何代码。
 *
 * 字段说明：
 * - use: LangChain 模型类的模块路径，格式为 "module:ClassName"
 * - apiKey/baseURL: 以 "$" 开头表示引用环境变量
 * - patches: 实例化后需要应用的补丁列表
 * - modelKwargs: 额外的模型参数，会合并到请求体中
 *
 * @module lib/llm/models.config
 */

import { ModelConfig } from "./types";

/**
 * 所有可用模型的配置列表
 */
export const modelConfigs: ModelConfig[] = [
  {
    name: "openrouter",
    use: "@langchain/openai:ChatOpenAI",
    model: "openai/gpt-4-turbo-preview",
    apiKey: "$OPENAI_API_KEY",
    defaultTemperature: 0.7,
    defaultMaxTokens: 2000,
    defaultTimeout: 15000,
  },

  {
    name: "qwen",
    use: "@langchain/openai:ChatOpenAI",
    model: "qwen3.6-plus",
    apiKey: "$OPENAI_QWEN_API_KEY",
    baseURL: "$OPENAI_QWEN_BASE_URL",
    patches: ["dashscope-toolcall-fix"],
    modelKwargs: {
      enable_thinking: false,
    },
    defaultTemperature: 0.3,
    defaultMaxTokens: 2000,
    defaultTimeout: 15000,
  },

  {
    name: "spark",
    use: "@langchain/openai:ChatOpenAI",
    model: "spark-v3.5",
    apiKey: "$OPENAI_SPARK_API_KEY",
    baseURL: "$OPENAI_SPARK_BASE_URL",
    defaultTemperature: 0.3,
    defaultMaxTokens: 2000,
    defaultTimeout: 15000,
  },
];
