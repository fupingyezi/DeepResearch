/**
 * Middleware execution order（必须严格按 0 → 13 编排）：
 *
 *  0. ThreadDataMiddleware              (基础设施)
 *  1. UploadsMiddleware                 (基础设施)
 *  2. SandboxMiddleware                 (基础设施 / features.sandbox)
 *  3. ToolCallIntegrityMiddleware       (始终启用) —— 统一处理消息层面的工具调用完整性
 *  4. GuardrailMiddleware               (features.guardrail)
 *  5. ToolErrorHandlingMiddleware       (始终启用)
 *  6. SummarizationMiddleware           (features.summarization)
 *  7. TodoMiddleware                    (plan_mode 参数)
 *  8. TitleMiddleware                   (features.autoTitle)
 *  9. MemoryMiddleware                  (features.memory)
 * 10. ViewImageMiddleware               (features.vision)
 * 11. SubagentLimitMiddleware           (features.subagent)
 * 12. LoopDetectionMiddleware           (始终启用)
 * 13. ClarificationMiddleware           (始终最后)
 *
 * 关键顺序约束：
 * - ToolCallIntegrity (3) **先于** ToolErrorHandling (5)：在到达 ToolNode
 *   派发之前清理掉所有"消息层面"的工具调用问题（悬挂 tool_call、未知工具
 *   引用），从根上杜绝 LangGraph 抛出 "Tool not found" 之类异常。
 *   ToolErrorHandling 的 wrapToolCall 处理的是 *工具自身执行时* 抛出的
 *   异常，定位不同、不可互替。
 *
 * 添加新的"消息层面工具调用完整性问题"请优先实现 IntegrityRule 注册到
 * ToolCallIntegrityMiddleware（见 tool-call-integrity/rules/），不要再
 * 新增同类中间件。
 */

export { threadDataMiddleware } from './thread-data-middleware';
export { uploadsMiddleware } from './uploads-middleware';
export { sandboxMiddleware } from './sandbox-middleware';
export {
  toolCallIntegrityMiddleware,
  createToolCallIntegrityMiddleware,
  DEFAULT_INTEGRITY_RULES,
} from './tool-call-integrity';
export type {
  IntegrityRule,
  RuleContext,
  ToolCallIntegrityOptions,
} from './tool-call-integrity';
export { guardrailMiddleware } from './guardrail-middleware';
export { toolErrorHandlingMiddleware } from './tool-error-handling-middleware';
export { summarizationMiddleware } from './summarization-middleware';
export { todoMiddleware } from './todo-middleware';
export { titleMiddleware } from './title-middleware';
export { memoryMiddleware } from './memory-middleware';
export { viewImageMiddleware } from './view-image-middleware';
export { subagentLimitMiddleware } from './subagent-limit-middleware';
export { loopDetectionMiddleware } from './loop-detection-middleware';
export { clarificationMiddleware } from './clarification-middleware';
export { qwenToolCallRecoveryMiddleware } from './qwen-tool-call-recovery-middleware';
export { withCallLog, withCallLogAll } from './with-call-log';
export type { WithCallLogOptions } from './with-call-log';

import { threadDataMiddleware } from './thread-data-middleware';
import { uploadsMiddleware } from './uploads-middleware';
import { sandboxMiddleware } from './sandbox-middleware';
import { toolCallIntegrityMiddleware } from './tool-call-integrity';
import { guardrailMiddleware } from './guardrail-middleware';
import { toolErrorHandlingMiddleware } from './tool-error-handling-middleware';
import { summarizationMiddleware } from './summarization-middleware';
import { todoMiddleware } from './todo-middleware';
import { titleMiddleware } from './title-middleware';
import { memoryMiddleware } from './memory-middleware';
import { viewImageMiddleware } from './view-image-middleware';
import { subagentLimitMiddleware } from './subagent-limit-middleware';
import { loopDetectionMiddleware } from './loop-detection-middleware';
import { clarificationMiddleware } from './clarification-middleware';

/**
 * 严格按编排位序（0 → 13）排列的中间件数组。
 * 装配层可基于 RuntimeFeatures 在此基础上做过滤 / 替换。
 */
export const ORDERED_MIDDLEWARES = [
  threadDataMiddleware, // 0
  uploadsMiddleware, // 1
  sandboxMiddleware, // 2
  toolCallIntegrityMiddleware, // 3
  guardrailMiddleware, // 4
  toolErrorHandlingMiddleware, // 5
  summarizationMiddleware, // 6
  todoMiddleware, // 7
  titleMiddleware, // 8
  memoryMiddleware, // 9
  viewImageMiddleware, // 10
  subagentLimitMiddleware, // 11
  loopDetectionMiddleware, // 12
  clarificationMiddleware, // 13
] as const;
