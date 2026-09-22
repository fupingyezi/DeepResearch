import type { SavedFileMetadata } from '../file-metadata/types';

/** 新上传文件的解析记录初始行（status='parsing'）。 */
export interface InsertParsingInput {
  minioBucket: string;
  minioKey: string;
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface FileContentStore {
  /** 上传成功后插入 status='parsing' 行（解析结果随后 markSuccess/markFailed 回写） */
  insertParsing(input: InsertParsingInput): Promise<void>;
  markSuccess(minioKey: string, content: string): Promise<void>;
  markFailed(minioKey: string, errorMessage: string): Promise<void>;
  /**
   * 按 fileId 批量反查文件元信息（v3/chat 把 contents 里的 file/image 块解析为落库元信息）。
   * 空入参返回 []；结果按入参顺序返回（content block 的视觉顺序对消息渲染重要）。
   */
  getByIds(fileIds: string[]): Promise<SavedFileMetadata[]>;
  /** minio_key LIKE '%fragment%'（files/delete 回退路径：fileId 可能只是 key 的一部分） */
  getMinioKeysLike(fragment: string): Promise<string[]>;
  deleteByMinioKey(minioKey: string): Promise<void>;
  deleteByMinioKeys(minioKeys: string[]): Promise<void>;
}
