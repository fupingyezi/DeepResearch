import { createMiddleware } from 'langchain';

/**
 * UploadsMiddleware（位序 1 / 基础设施）
 *
 * 职责（占位）：
 * - 在 sandbox 创建前，处理用户附件上传：解析 ThreadState.uploadedFiles，
 *   将文件落到 ThreadData.uploadsPath，统一规范化路径与 mime。
 *
 * 注意：
 * - 依赖 ThreadDataMiddleware 提供的 threadData。
 * - 必须排在 SandboxMiddleware 之前，使 sandbox 能挂载完整的 uploads 目录。
 */
export const uploadsMiddleware = createMiddleware({
  name: 'UploadsMiddleware',
});
