/**
 * 模型补丁注册机制
 *
 * 将 DashScope 等提供商的兼容性修复以插件化方式管理。
 * 通过配置文件中的 patches 字段声明需要应用的补丁，
 * 无需修改代码即可启用/禁用补丁。
 *
 * @module lib/llm/patches
 */

/**
 * 模型补丁函数类型
 *
 * 接收一个模型实例，返回修补后的模型实例（可以是同一个实例的 mutation）。
 */
export type ModelPatch = (model: any) => any;

/**
 * 补丁注册表
 */
const patchRegistry = new Map<string, ModelPatch>();

/**
 * DashScope tool_call id 修复补丁
 *
 * DashScope（阿里云百炼）的 OpenAI 兼容接口存在以下问题：
 * 1. tool_call 的 id 字段返回空字符串，导致 LangChain 将其标记为 invalid_tool_calls
 * 2. LangChain 的 AIMessageChunk 构造函数中 `!id` 校验会将空 id 的 tool_call 视为无效
 *
 * 此补丁通过 monkey-patch ChatOpenAI 内部的 completions 实例的
 * `_convertCompletionsDeltaToBaseMessageChunk` 方法来修复此问题。
 */
function dashscopeToolcallFix(model: any): any {
  const completions = model.completions;
  if (!completions) {
    return model;
  }

  let toolCallIdCounter = 0;
  const toolCallIdMap = new Map<number, string>();
  let lastResponseId = "";

  const originalMethod =
    completions._convertCompletionsDeltaToBaseMessageChunk.bind(completions);

  completions._convertCompletionsDeltaToBaseMessageChunk = (
    delta: any,
    rawResponse: any,
    defaultRole?: string,
  ) => {
    // 检测新的 LLM 调用，清空缓存
    const responseId = rawResponse?.id || "";
    if (responseId && responseId !== lastResponseId) {
      lastResponseId = responseId;
      toolCallIdMap.clear();
    }

    // 修复 DashScope 返回的空 tool_call id
    if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
      for (const toolCall of delta.tool_calls) {
        if (!toolCall.id) {
          const index = toolCall.index ?? 0;
          if (!toolCallIdMap.has(index)) {
            toolCallIdCounter++;
            toolCallIdMap.set(
              index,
              `call_dashscope_${Date.now()}_${toolCallIdCounter}`,
            );
          }
          toolCall.id = toolCallIdMap.get(index)!;
        }
      }
    }

    return originalMethod(delta, rawResponse, defaultRole);
  };

  return model;
}

// 注册内置补丁
patchRegistry.set("dashscope-toolcall-fix", dashscopeToolcallFix);

/**
 * 对模型实例应用指定的补丁列表
 *
 * @param model - 模型实例
 * @param patchNames - 需要应用的补丁名称列表
 * @returns 应用补丁后的模型实例
 *
 * @example
 * ```typescript
 * const patchedModel = applyPatches(model, ["dashscope-toolcall-fix"]);
 * ```
 */
export function applyPatches(model: any, patchNames: string[]): any {
  let patchedModel = model;

  for (const patchName of patchNames) {
    const patch = patchRegistry.get(patchName);
    if (!patch) {
      console.warn(
        `[LLM Patches] 警告：未知的补丁 "${patchName}"，已跳过。`,
      );
      continue;
    }
    patchedModel = patch(patchedModel);
  }

  return patchedModel;
}

/**
 * 注册自定义补丁（用于扩展）
 *
 * @param name - 补丁名称
 * @param patch - 补丁函数
 */
export function registerPatch(name: string, patch: ModelPatch): void {
  patchRegistry.set(name, patch);
}
