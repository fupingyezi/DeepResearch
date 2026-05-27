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

export interface UploadedFile {
  // 与 Python 的 list[dict] 对齐，按需补字段
  [key: string]: any;
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
