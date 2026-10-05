/**
 * 文件域服务：上传（MinIO + file_content 解析状态机）与删除（双表回退）编排。
 *
 * 上传状态机：insertParsing(parsing) → extractTextFromFile → markSuccess(success)
 * 或 markFailed(failed)。解析失败**不是**请求失败——file_content 已记录失败原因，
 * 前端以 error 字段呈现，HTTP 仍 200。
 */

import { uploadFile } from '@/lib';
import { extractTextFromFile } from '@/lib/files/file-parser';
import { deleteFile } from '@/lib/storage';
import { AppError } from '@/server/http';
import { PgFileContentStore, type FileContentStore } from '@/server/daos/file-content';
import { PgFileMetadataStore, type FileMetadataStore } from '@/server/daos/file-metadata';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

export interface UploadedFileResult {
  fileId: string;
  minioKey: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** 解析成功：正文前 200 字预览 */
  content?: string;
  /** 解析失败：错误信息（HTTP 仍 200） */
  error?: string;
}

export interface FileServiceDeps {
  fileMetadata: FileMetadataStore;
  fileContent: FileContentStore;
  deleteObject: (minioKey: string) => Promise<void>;
}

export class FileService {
  constructor(private readonly deps: FileServiceDeps) {}

  /**
   * 上传并解析：MinIO 落对象 → file_content 记 parsing → 解析 → success/failed 回写。
   * 任何一步失败（解析除外）都清理已上传的对象后抛出。
   */
  async uploadFile(file: File, fileId: string): Promise<UploadedFileResult> {
    if (file.size > MAX_FILE_SIZE) {
      throw new AppError('File size exceeds 50MB limit', 'FILE_TOO_LARGE', 413);
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let uploadedKey: string | null = null;
    try {
      const { objectKey: minioKey } = await uploadFile(file.name, fileId, buffer);
      uploadedKey = minioKey;

      const mimeType = file.type || 'application/octet-stream';
      const sizeBytes = buffer.length;
      await this.deps.fileContent.insertParsing({
        minioBucket: process.env.MINIO_BUCKET!,
        minioKey,
        fileId,
        filename: file.name,
        mimeType,
        sizeBytes,
      });

      try {
        const content = await extractTextFromFile(
          process.env.MINIO_BUCKET!,
          minioKey,
          mimeType,
          file.name,
        );

        await this.deps.fileContent.markSuccess(minioKey, content);

        return {
          fileId,
          minioKey,
          filename: file.name,
          mimeType,
          sizeBytes,
          content: content.substring(0, 200) + (content.length > 200 ? '...' : ''),
        };
      } catch (parseError) {
        console.error('Parse error:', parseError);
        const message = parseError instanceof Error ? parseError.message : String(parseError);

        await this.deps.fileContent.markFailed(minioKey, message);

        return {
          fileId,
          minioKey,
          filename: file.name,
          mimeType,
          sizeBytes,
          error: message,
        };
      }
    } catch (error) {
      console.error('Upload error:', error);

      // 上传成功但后续落库失败：清掉 MinIO 对象，不留孤儿
      if (uploadedKey) {
        try {
          await this.deps.deleteObject(uploadedKey);
        } catch (cleanupError) {
          console.error('Failed to cleanup uploaded file:', cleanupError);
        }
      }
      throw error;
    }
  }

  /**
   * 删除上传的文件：file_metadata 命中 → 取其 minio_key 并删行；未命中（可能还没
   * 写元信息）→ 回退按 file_content.minio_key LIKE 找（fileId 可能只是 key 的一部分）。
   * MinIO 对象删除失败只告警（记录已删，对象留下只是存储垃圾）。
   */
  async deleteUploadedFile(fileId: string): Promise<void> {
    const metadata = await this.deps.fileMetadata.getByFileId(fileId);

    let minioKey: string | null = null;
    if (metadata) {
      minioKey = metadata.minioKey;
      await this.deps.fileMetadata.deleteByFileId(fileId);
    } else {
      const keys = await this.deps.fileContent.getMinioKeysLike(fileId);
      if (keys.length > 0) minioKey = keys[0];
    }

    if (minioKey) {
      try {
        await this.deps.deleteObject(minioKey);
      } catch (storageError) {
        console.warn('Failed to delete from storage:', storageError);
      }

      await this.deps.fileContent.deleteByMinioKey(minioKey);
    }
  }
}

export function createFileService(deps?: Partial<FileServiceDeps>): FileService {
  return new FileService({
    fileMetadata: deps?.fileMetadata ?? new PgFileMetadataStore(),
    fileContent: deps?.fileContent ?? new PgFileContentStore(),
    deleteObject: deps?.deleteObject ?? deleteFile,
  });
}

// 模块级懒单例即可：本服务无状态，不需要 globalThis 防 HMR 分裂（与
// conversation-service 同一约定）。
let service: FileService | null = null;

export function getFileService(): FileService {
  if (!service) service = createFileService();
  return service;
}
