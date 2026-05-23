import { createMiddleware } from 'langchain';

/**
 * SandboxMiddleware（位序 2 / 基础设施）
 *
 * 职责（占位）：
 * - 创建 / 复用沙箱（如 e2b、本地容器），把 ThreadData & Uploads 挂载进去，
 *   并把 sandboxId 写回 ThreadState.sandbox 供后续工具使用。
 *
 * 注意：
 * - 依赖 ThreadData 与 Uploads 已就绪。
 * - 受 features.sandbox 控制；本占位仅注册名字，不做任何创建动作。
 */
export const sandboxMiddleware = createMiddleware({
  name: 'SandboxMiddleware',
});
