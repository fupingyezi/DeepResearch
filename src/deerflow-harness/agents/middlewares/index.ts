/**
 * Middleware execution order（必须严格按 0 → 13 编排）：
 *
 *  0. ThreadDataMiddleware       (基础设施)
 *  1. UploadsMiddleware          (基础设施)
 *  2. SandboxMiddleware          (基础设施 / features.sandbox)
 *  3. DanglingToolCallMiddleware (始终启用)
 *  4. GuardrailMiddleware        (features.guardrail)
 *  5. ToolErrorHandlingMiddleware(始终启用)
 *  6. SummarizationMiddleware    (features.summarization)
 *  7. TodoMiddleware             (plan_mode 参数)
 *  8. TitleMiddleware            (features.autoTitle)
 *  9. MemoryMiddleware           (features.memory)
 * 10. ViewImageMiddleware        (features.vision)
 * 11. SubagentLimitMiddleware    (features.subagent)
 * 12. LoopDetectionMiddleware    (始终启用)
 * 13. ClarificationMiddleware    (始终最后)
 */

export { threadDataMiddleware } from './thread-data-middleware';
export { uploadsMiddleware } from './uploads-middleware';
export { sandboxMiddleware } from './sandbox-middleware';
export { danglingToolCallMiddleware } from './dangling-tool-call-middleware';
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

import { threadDataMiddleware } from './thread-data-middleware';
import { uploadsMiddleware } from './uploads-middleware';
import { sandboxMiddleware } from './sandbox-middleware';
import { danglingToolCallMiddleware } from './dangling-tool-call-middleware';
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
  danglingToolCallMiddleware, // 3
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
