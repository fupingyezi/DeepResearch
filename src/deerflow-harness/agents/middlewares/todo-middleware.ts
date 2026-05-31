import { createMiddleware } from 'langchain';

/**
 * TodoMiddleware（占位）
 *
 * 预留接口：在模型调用前后维护 ThreadState.todos，提供"先规划再执行"的
 * 能力（含子任务勾选 / 状态机更新）。当前未启用任何 hook。
 */
export const todoMiddleware = createMiddleware({
  name: 'TodoMiddleware',
});
