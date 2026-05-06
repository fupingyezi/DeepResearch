/**
 * 环境变量解析工具
 *
 * 将配置中以 "$" 开头的字符串解析为对应的环境变量值。
 * 支持延迟解析：加载时仅警告，实际使用时才报错。
 *
 * @module lib/llm/resolveEnv
 */

import { ConfigurationError } from "./types";

/**
 * 解析环境变量引用
 *
 * 当值以 "$" 开头时，从 process.env 中读取对应的环境变量。
 * 如果环境变量不存在，抛出 ConfigurationError。
 *
 * @param value - 原始配置值（可能是 "$ENV_VAR_NAME" 格式或普通字符串）
 * @returns 解析后的实际值
 * @throws ConfigurationError 如果引用的环境变量不存在
 *
 * @example
 * ```typescript
 * resolveEnvValue("$OPENAI_API_KEY"); // => "sk-xxx..."
 * resolveEnvValue("https://api.openai.com"); // => "https://api.openai.com"（原样返回）
 * ```
 */
export function resolveEnvValue(value: string): string {
  if (!value.startsWith("$")) {
    return value;
  }

  const envName = value.slice(1);
  const envValue = process.env[envName];

  if (!envValue) {
    throw new ConfigurationError(
      `环境变量 "${envName}" 未设置。请在 .env 文件中配置该变量。`,
    );
  }

  return envValue;
}

/**
 * 检查环境变量是否存在（仅警告，不抛错）
 *
 * 用于配置加载阶段的预检查，输出警告日志但不阻止启动。
 *
 * @param value - 原始配置值
 * @returns 环境变量是否存在（非 "$" 开头的值始终返回 true）
 */
export function checkEnvExists(value: string): boolean {
  if (!value.startsWith("$")) {
    return true;
  }

  const envName = value.slice(1);
  const envValue = process.env[envName];

  if (!envValue) {
    console.warn(
      `[LLM Config] 警告：环境变量 "${envName}" 未设置，使用该模型时将会报错。`,
    );
    return false;
  }

  return true;
}
