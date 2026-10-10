import { query } from '@/lib/db';

import type { SavedFileMetadata } from '../file-metadata/types';
import type { FileContentStore, InsertParsingInput } from './types';

type Row = Record<string, unknown>;

export class PgFileContentStore implements FileContentStore {
  async insertParsing(input: InsertParsingInput): Promise<void> {
    await query(
      `
        INSERT INTO file_content (
          minio_bucket, minio_key, status, file_id, filename, mime_type, size_bytes, user_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        input.minioBucket,
        input.minioKey,
        'parsing',
        input.fileId,
        input.filename,
        input.mimeType,
        input.sizeBytes,
        input.userId,
      ],
    );
  }

  async markSuccess(minioKey: string, content: string): Promise<void> {
    await query(
      `
        UPDATE file_content
        SET content = $1, status = $2, updated_at = now()
        WHERE minio_key = $3
      `,
      [content, 'success', minioKey],
    );
  }

  async markFailed(minioKey: string, errorMessage: string): Promise<void> {
    await query(
      `
        UPDATE file_content
        SET status = $1, error_message = $2, updated_at = now()
        WHERE minio_key = $3
      `,
      ['failed', errorMessage, minioKey],
    );
  }

  async getOwnerByFileId(fileId: string): Promise<string | null> {
    const res = await query('SELECT user_id FROM file_content WHERE file_id = $1', [fileId]);
    const row = res.rows[0] as Row | undefined;
    return row ? String(row.user_id ?? '') || null : null;
  }

  async getByIds(fileIds: string[]): Promise<SavedFileMetadata[]> {
    if (!Array.isArray(fileIds) || fileIds.length === 0) return [];

    const uniqueIds = Array.from(
      new Set(fileIds.filter((id) => typeof id === 'string' && id.length > 0)),
    );
    if (uniqueIds.length === 0) return [];

    const res = await query(
      `select file_id, filename, mime_type, size_bytes, minio_key
         from file_content
        where file_id = any($1::uuid[])`,
      [uniqueIds],
    );

    const byId = new Map<string, SavedFileMetadata>();
    for (const row of res.rows) {
      const fileId = String((row as Row).file_id ?? '');
      if (!fileId) continue;
      byId.set(fileId, {
        fileId,
        filename: String((row as Row).filename ?? ''),
        mimeType: String((row as Row).mime_type ?? ''),
        sizeBytes: Number((row as Row).size_bytes ?? 0),
        minioKey: String((row as Row).minio_key ?? ''),
      });
    }

    // 保持入参顺序返回（content block 的视觉顺序对消息渲染重要）
    const ordered: SavedFileMetadata[] = [];
    for (const id of fileIds) {
      const hit = byId.get(id);
      if (hit) ordered.push(hit);
    }
    return ordered;
  }

  async getMinioKeysLike(fragment: string): Promise<string[]> {
    const res = await query('SELECT minio_key FROM file_content WHERE minio_key LIKE $1', [
      `%${fragment}%`,
    ]);
    return res.rows.map((row: Row) => String(row.minio_key ?? ''));
  }

  async deleteByMinioKey(minioKey: string): Promise<void> {
    await query('DELETE FROM file_content WHERE minio_key = $1', [minioKey]);
  }

  async deleteByMinioKeys(minioKeys: string[]): Promise<void> {
    if (minioKeys.length === 0) return;
    await query(`delete from file_content where minio_key = any($1::text[]);`, [minioKeys]);
  }
}
