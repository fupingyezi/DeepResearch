import { query } from '@/backend/lib/db';

import type { UploadedFilesProvider } from '@deerflow-harness/agents/middlewares/uploaded-files';
import type { UploadedFile } from '@deerflow-harness/agents/thread-state';

/**
 * UploadedFilesProvider 的 app 实现：harness 的 thread-data-middleware 不再
 * 直连 SQL，经此适配器查 file_metadata / file_content。SQL 与行映射自
 * thread-data-middleware 逐字搬移，保证行为一致。
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

async function loadSessionUploadedFiles(threadId: string): Promise<UploadedFile[]> {
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

export const uploadedFilesProvider: UploadedFilesProvider = {
  loadSessionUploadedFiles,
};
