/**
 * 类解析器
 *
 * 根据 "module:ClassName" 格式的字符串加载 LangChain 模型类。
 * 使用静态模块注册表，新增提供商时在 moduleRegistry 中添加即可。
 *
 * @module lib/llm/classResolver
 */

import { ModelResolveError } from "./types";
import * as LangChainOpenAI from "@langchain/openai";

/**
 * 静态模块注册表
 *
 * 新增模型提供商时：
 * 1. 在文件顶部添加 `import * as XXX from "xxx";`
 * 2. 在此 registry 中添加 `"xxx": XXX`
 */
const moduleRegistry: Record<string, any> = {
  "@langchain/openai": LangChainOpenAI,
};

/**
 * 已解析类的缓存
 */
const classCache = new Map<string, any>();

/**
 * 解析模块路径中的类
 *
 * @param classPath - 格式为 "module:ClassName"（如 "@langchain/openai:ChatOpenAI"）
 * @returns 解析得到的类构造函数
 * @throws ModelResolveError 如果模块未注册或类在模块中不存在
 *
 * @example
 * ```typescript
 * const ChatOpenAI = await resolveClass("@langchain/openai:ChatOpenAI");
 * const model = new ChatOpenAI({ model: "gpt-4" });
 * ```
 */
export async function resolveClass(classPath: string): Promise<any> {
  // 检查缓存
  if (classCache.has(classPath)) {
    return classCache.get(classPath);
  }

  // 解析 "module:ClassName" 格式
  const colonIndex = classPath.lastIndexOf(":");
  if (colonIndex === -1) {
    throw new ModelResolveError(
      `类路径格式错误："${classPath}"。期望格式为 "module:ClassName"（如 "@langchain/openai:ChatOpenAI"）。`,
    );
  }

  const modulePath = classPath.slice(0, colonIndex);
  const className = classPath.slice(colonIndex + 1);

  if (!modulePath || !className) {
    throw new ModelResolveError(
      `类路径格式错误："${classPath}"。模块路径和类名均不能为空。`,
    );
  }

  // 从静态注册表中查找模块
  const module = moduleRegistry[modulePath];
  if (!module) {
    const registeredModules = Object.keys(moduleRegistry).join(", ");
    throw new ModelResolveError(
      `模块 "${modulePath}" 未在注册表中注册。` +
      `请在 classResolver.ts 的 moduleRegistry 中添加该模块的静态导入。` +
      `当前已注册：${registeredModules}`,
    );
  }

  // 获取目标类
  const targetClass = module[className];
  if (!targetClass) {
    throw new ModelResolveError(
      `模块 "${modulePath}" 中不存在类 "${className}"。可用的导出：${Object.keys(module).join(", ")}`,
    );
  }

  // 缓存并返回
  classCache.set(classPath, targetClass);
  return targetClass;
}

/**
 * 注册自定义模块到注册表（用于插件扩展或测试）
 */
export function registerModule(modulePath: string, moduleExports: any): void {
  moduleRegistry[modulePath] = moduleExports;
}

/**
 * 清除类解析缓存（主要用于测试）
 */
export function clearClassCache(): void {
  classCache.clear();
}
