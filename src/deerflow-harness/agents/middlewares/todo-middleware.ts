import { createMiddleware } from 'langchain';

/**
 * TodoMiddleware（位序 7 / plan_mode 参数启用）
 *
 * 职责（占位）：
 * - 结合 plan_mode：在模型调用前后维护 ThreadState.todos，
 *   提供"先规划再执行"的能力（含子任务勾选 / 状态机更新）。
 */
export const todoMiddleware = createMiddleware({
  name: 'TodoMiddleware',
});
