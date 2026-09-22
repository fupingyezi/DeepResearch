import type { fileMetadataType } from '@/types';

import type { SqlExecutor } from '../shared';

/**
 * file_metadata 表 —— 消息与上传文件的关联元信息。
 *
 * ⚠️ 本 store 不是该表的唯一读写入口：harness 的 thread-data-middleware 会绕过本
 * store 直接读该表（按 thread_id 查询装载 uploadedFiles），修改表结构时必须同步
 * 检查那一处 SQL。
 */

/** 已上传文件的最小元信息（chat 落库 / history 加载共用的单一出处）。 */
export interface SavedFileMetadata {
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  minioKey: string;
}

export interface FileMetadataStore {
  /**
   * 批量写入一条消息关联的文件元信息（与 chat_message insert 同一事务）。
   * MINIO_BUCKET 未配置时告警跳过（与历史行为一致）。
   */
  insertMany(
    rows: SavedFileMetadata[],
    opts: { sessionId: string; messageId: string },
    db?: SqlExecutor,
  ): Promise<void>;
  /** 按 uploaded_at asc 返回前端 fileMetadataType 形状 */
  listBySession(sessionId: string): Promise<fileMetadataType[]>;
  /**
   * 会话引用过的全部 minio_key（file_metadata 直查 + file_content join 补漏）。
   * deleteSession 事务内调用 —— file_metadata 行会随 chat_message 级联消失，而
   * MinIO 对象不在事务里，必须先捞出来留到 commit 之后去删。
   */
  minioKeysForSessionDelete(sessionId: string, db?: SqlExecutor): Promise<string[]>;
  /** 哪些 key 仍被引用（deleteSession 提交后查，此刻还查得到的必然是别人的引用） */
  stillReferenced(minioKeys: string[]): Promise<string[]>;
  /** 按 fileId 取元信息（files/delete 主路径） */
  getByFileId(fileId: string): Promise<{ minioKey: string } | null>;
  deleteByFileId(fileId: string): Promise<void>;
}
