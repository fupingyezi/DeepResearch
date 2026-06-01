import { AgentMiddleware, todoListMiddleware } from 'langchain';

/**
 * TodoMiddleware —— 复用 LangChain 现成的 todoListMiddleware
 *
 * 提供 write_todos 工具 + ThreadState.todos 跟踪，实现「先规划再执行」。
 * 仅在 features.todo 显式开启时装配（默认关闭，避免对简单对话引入额外规划开销）。
 *
 * 优先使用框架现成能力而非自造，对齐 deer-flow 2.0 的 TodoListMiddleware。
 */
export const todoMiddleware = todoListMiddleware() as AgentMiddleware;
