import { createMiddleware } from 'langchain';

import { query } from '@/lib/db';
import { getContext } from '../../runtime/context';
import { getThreadDirectories } from '../../sandbox';
import type { ThreadDataState, UploadedFile } from '../thread-state';

/**
 * ThreadDataMiddleware（基础设施）
 *
 * 职责：
 * - `beforeAgent` 阶段从 PostgreSQL 加载本会话关联的上传文件元信息 + 解析后全文，
 *   写入 `state.uploadedFiles`；同时初始化 `state.threadData`（按 thread_id 计算
 *   workspace/uploads/outputs 实际目录），为下游 `UploadsMiddleware` 与 sandbox
 *   工具提供数据基座。
 *
 * 触发与幂等：
 * - 必须能从 `getContext()` 拿到 `thread_id`（lead-agent 入口已注入）；缺失直接 return。
 * - `state.uploadedFiles` 已非空（同一 run 内重复进入）则直接 return，避免重复查询。
 *
 * 错误隔离：任何异常仅 console.error，不影响主流程。
 *
 * 顺序：必须排在 UploadsMiddleware 与 SandboxMiddleware 之前。由
 * `ORDERED_MIDDLEWARES` 位序保证。
 */

interface UploadedFileRow {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  minio_key: string;
  /** pg 通常返回 Date 对象（timestamptz），但兼容字符串/数字。 */
  uploaded_at: Date | string | number;
  content: string | null;
}

/**
 * 单条 SQL（join file_content）+ session 索引 `idx_file_by_message`，O(N≤10)。
 *
 * 取最近 10 个文件：避免长会话累积大量历史文件无限拉取，导致内存膨胀与 prompt
 * 体积失控。注入到 prompt 的截断由 UploadsMiddleware 负责。
 */
const LOAD_UPLOADED_FILES_SQL = `
  select
    fm.id,
    fm.filename,
    fm.mime_type,
    fm.size_bytes,
    fm.minio_key,
    fm.uploaded_at,
    fc.content
  from file_metadata fm
  left join file_content fc on fc.minio_key = fm.minio_key
  where fm.session_id = $1
  order by fm.uploaded_at desc
  limit 10;
`;

/**
 * 加载本会话关联的上传文件（元信息 + 解析全文）。
 *
 * **导出供 UploadsMiddleware 直接调用**：LangChain v1 中每个中间件节点的输入被限制为
 * 该中间件自身声明的私有 state + `messages`（见 `MiddlewareNode` 的
 * `nodeOptions.input = derivePrivateState(stateSchema)`），**跨中间件的 state 读取不成立**
 * —— 下游读不到本中间件写入的 `state.uploadedFiles`。故下游需要能自行取数。
 */
export async function loadSessionUploadedFiles(threadId: string): Promise<UploadedFile[]> {
  const res = await query(LOAD_UPLOADED_FILES_SQL, [threadId]);
  const rows = (res.rows ?? []) as UploadedFileRow[];
  return rows.map((row) => ({
    fileId: String(row.id),
    filename: String(row.filename ?? ''),
    mimeType: String(row.mime_type ?? ''),
    sizeBytes: Number(row.size_bytes ?? 0),
    minioKey: String(row.minio_key ?? ''),
    content: row.content ?? null,
    uploadedAt:
      row.uploaded_at instanceof Date
        ? row.uploaded_at.toISOString()
        : new Date(row.uploaded_at).toISOString(),
  }));
}

export const threadDataMiddleware = createMiddleware({
  name: 'ThreadDataMiddleware',
  beforeAgent: async (state: any) => {
    try {
      const ctx = getContext();
      const threadId = ctx?.thread_id;
      if (!threadId) return undefined;

      // 幂等：state 已写过则跳过
      const existing = state?.uploadedFiles;
      if (Array.isArray(existing) && existing.length > 0) return undefined;

      const uploadedFiles = await loadSessionUploadedFiles(threadId);

      // 空数组也写入 + threadData 占位，避免下游每次都判空
      return {
        uploadedFiles,
        threadData: buildThreadData(threadId),
      };
    } catch (e) {
      console.error('[threadDataMiddleware] beforeAgent error:', e);
      return undefined;
    }
  },
});

function buildThreadData(threadId: string): ThreadDataState {
  const dirs = getThreadDirectories(threadId);
  return {
    workspacePath: dirs.workspace,
    uploadsPath: dirs.uploads,
    outputsPath: dirs.outputs,
  };
}
