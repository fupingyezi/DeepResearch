import { query } from '@/lib/db';
import type { fileMetadataType } from '@/types';

import type { SqlExecutor } from '../shared';
import type { FileMetadataStore, SavedFileMetadata } from './types';

type Row = Record<string, unknown>;

const INSERT_SQL = `insert into file_metadata (
  id, message_id, session_id, filename, mime_type, size_bytes, minio_bucket, minio_key
) values ($1, $2, $3, $4, $5, $6, $7, $8)`;

function rowToFileMetadata(row: Row): fileMetadataType {
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    sessionId: String(row.session_id),
    filename: String(row.filename),
    mimeType: String(row.mime_type ?? ''),
    sizeBytes: Number(row.size_bytes ?? 0),
    minioBucket: String(row.minio_bucket ?? ''),
    minioKey: String(row.minio_key ?? ''),
    uploadedAt: new Date(row.uploaded_at as string | number | Date),
  };
}

export class PgFileMetadataStore implements FileMetadataStore {
  async insertMany(
    rows: SavedFileMetadata[],
    opts: { sessionId: string; messageId: string },
    db?: SqlExecutor,
  ): Promise<void> {
    if (!rows || rows.length === 0) return;
    const bucket = process.env.MINIO_BUCKET;
    if (!bucket) {
      console.warn('[file-metadata] MINIO_BUCKET not set, skip file metadata insert.');
      return;
    }
    const insert = async (exec: SqlExecutor): Promise<void> => {
      for (const file of rows) {
        await exec.query(INSERT_SQL, [
          file.fileId,
          opts.messageId,
          opts.sessionId,
          file.filename,
          file.mimeType,
          file.sizeBytes,
          bucket,
          file.minioKey,
        ]);
      }
    };
    if (db) await insert(db);
    else await insert({ query });
  }

  async listBySession(sessionId: string): Promise<fileMetadataType[]> {
    const res = await query(
      `select id, message_id, session_id, filename, mime_type, size_bytes, minio_bucket, minio_key, uploaded_at
         from file_metadata
        where session_id = $1
        order by uploaded_at asc;`,
      [sessionId],
    );
    return res.rows.map((row: Row) => rowToFileMetadata(row));
  }

  async minioKeysForSessionDelete(sessionId: string, db?: SqlExecutor): Promise<string[]> {
    const sql = `
      select distinct fm.minio_key
        from file_metadata fm
       where fm.session_id = $1
       union
      select distinct fc.minio_key
        from file_content fc
        join file_metadata fm2 on fm2.id = fc.file_id
       where fm2.session_id = $1;
    `;
    const params: unknown[] = [sessionId];
    const res = db ? await db.query(sql, params) : await query(sql, params);
    return res.rows
      .map((row) => String((row as Row).minio_key ?? ''))
      .filter((key: string) => key.length > 0);
  }

  async stillReferenced(minioKeys: string[]): Promise<string[]> {
    if (minioKeys.length === 0) return [];
    const res = await query(
      `select distinct minio_key from file_metadata where minio_key = any($1::text[]);`,
      [minioKeys],
    );
    return res.rows.map((row) => String((row as Row).minio_key ?? ''));
  }

  async getByFileId(fileId: string): Promise<{ minioKey: string } | null> {
    const res = await query('SELECT * FROM file_metadata WHERE id = $1', [fileId]);
    const row = res.rows[0] as Row | undefined;
    return row ? { minioKey: String(row.minio_key ?? '') } : null;
  }

  async deleteByFileId(fileId: string): Promise<void> {
    await query('DELETE FROM file_metadata WHERE id = $1', [fileId]);
  }
}
