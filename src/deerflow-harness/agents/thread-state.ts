import { Annotation, MessagesAnnotation } from '@langchain/langgraph';

export interface SandboxState {
  sandboxId?: string | null;
}

export interface ThreadDataState {
  workspacePath?: string | null;
  uploadsPath?: string | null;
  outputsPath?: string | null;
}

export interface ViewedImageData {
  base64: string;
  mimeType: string;
}

/**
 * 上传文件在 ThreadState 中的运行期表示（由 ThreadDataMiddleware 装载）。
 *
 * 与 chat_message.parts/file_metadata 表的差异：
 * - file_metadata 是「持久化」事实，记录 message ↔ file 关系；
 * - UploadedFile 是「运行期」上下文，扁平包含文件元信息 + 解析后的 content
 *   全文（来自 file_content.content 列），供 UploadsMiddleware 注入 prompt。
 *
 * 字段保留可选 + 索引签名
 */
export interface UploadedFile {
  fileId?: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  minioKey?: string;
  /** 解析后的全文（file_content.content）；可能为 null（解析失败 / 未解析）。 */
  content?: string | null;
  /** ISO8601 上传时间。 */
  uploadedAt?: string;
  [key: string]: unknown;
}

/** Reducer for artifacts list - 合并并去重 */
export function mergeArtifacts(
  existing: string[] | undefined,
  next: string[] | undefined,
): string[] {
  if (existing == null) return next ?? [];
  if (next == null) return existing;
  // 用 Set 去重，保持顺序
  return Array.from(new Set([...existing, ...next]));
}

/**
 * Reducer for viewed_images dict - 合并 image 字典
 *
 * 特殊语义：如果 next 是空对象 `{}`，则清空 existing。
 * 中间件可以通过返回 `{}` 在处理后清理 viewed_images 状态。
 */
export function mergeViewedImages(
  existing: Record<string, ViewedImageData> | undefined,
  next: Record<string, ViewedImageData> | undefined,
): Record<string, ViewedImageData> {
  if (existing == null) return next ?? {};
  if (next == null) return existing;
  // 空对象 = 清空
  if (Object.keys(next).length === 0) return {};
  // 同 key 时 next 覆盖 existing
  return { ...existing, ...next };
}

export const ThreadStateAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,

  sandbox: Annotation<SandboxState | null | undefined>(),
  threadData: Annotation<ThreadDataState | null | undefined>(),
  title: Annotation<string | null | undefined>(),

  artifacts: Annotation<string[]>({
    reducer: mergeArtifacts,
    default: () => [],
  }),

  todos: Annotation<any[] | null | undefined>(),
  uploadedFiles: Annotation<UploadedFile[] | null | undefined>(),

  viewedImages: Annotation<Record<string, ViewedImageData>>({
    reducer: mergeViewedImages,
    default: () => ({}),
  }),
});

export type ThreadState = typeof ThreadStateAnnotation.State;
export type ThreadStateUpdate = typeof ThreadStateAnnotation.Update;

export const DEFAULT_STATE: ThreadState = {
  messages: [],
  sandbox: null,
  threadData: null,
  title: null,
  artifacts: [],
  todos: null,
  uploadedFiles: null,
  viewedImages: {},
};
