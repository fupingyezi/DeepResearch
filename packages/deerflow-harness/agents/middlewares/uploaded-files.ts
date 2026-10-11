/**
 * UploadedFilesProvider —— 会话上传文件的加载注入面。
 *
 * thread-data-middleware 需要按 thread_id 查 app 侧的 file_metadata /
 * file_content 两表；harness 不反向依赖宿主 DB，由宿主（wiring /
 * harness-adapters）注入实现。未注入时返回空列表（本会话无文件注入，warn 一次）。
 */

import type { UploadedFile } from '../thread-state';

export interface UploadedFilesProvider {
  /** 按会话加载上传文件（元信息 + 解析全文），按上传时间倒序。 */
  loadSessionUploadedFiles(threadId: string): Promise<UploadedFile[]>;
}

// dev 下注册表挂 globalThis：理由同 title-store.ts（Next 按路由分包编译，
// 模块级变量会分裂成多份导致注入静默失效）。
let _provider: UploadedFilesProvider | null = null;

const globalForUploadedFiles =
  process.env.NODE_ENV === 'production'
    ? null
    : (globalThis as unknown as { __uploadedFilesProvider?: UploadedFilesProvider | null });

export function setUploadedFilesProvider(provider: UploadedFilesProvider | null): void {
  if (globalForUploadedFiles) globalForUploadedFiles.__uploadedFilesProvider = provider;
  else _provider = provider;
}

export function getUploadedFilesProvider(): UploadedFilesProvider | null {
  return globalForUploadedFiles?.__uploadedFilesProvider ?? _provider;
}
