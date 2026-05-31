import { createMiddleware } from 'langchain';

/**
 * ThreadDataMiddleware（基础设施）
 *
 * 职责（占位）：
 * - 在 agent 启动前，从持久化层加载 thread 元数据（workspacePath / uploadsPath / outputsPath 等），
 *   写入 ThreadState.threadData，为后续 Uploads / Sandbox 中间件提供基础。
 *
 * 注意：
 * - 必须排在 Uploads 与 Sandbox 之前。
 * - 当前为空实现，仅注册中间件，不修改 state。
 */
export const threadDataMiddleware = createMiddleware({
  name: 'ThreadDataMiddleware',
});
