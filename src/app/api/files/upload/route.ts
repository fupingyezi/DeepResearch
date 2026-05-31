import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { uploadFile, ensureBucket } from '@/lib';
import { extractTextFromFile } from '@/lib/file-parser';

export async function POST(request: NextRequest) {
  let uploadedKey: string | null = null;

  try {
    await ensureBucket();

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const fileId = formData.get('fileId') as string;

    if (!file || !fileId) {
      return NextResponse.json({ error: 'Missing file or fileId' }, { status: 400 });
    }

    // 基本文件验证
    const maxSize = 50 * 1024 * 1024; // 50MB
    if (file.size > maxSize) {
      return NextResponse.json({ error: 'File size exceeds 50MB limit' }, { status: 413 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 上传到MinIO
    const { objectKey: minioKey } = await uploadFile(file.name, fileId, buffer);
    uploadedKey = minioKey;

    // 先插入file_content记录，状态为parsing
    // 同时写入 fileId / filename / mime_type / size_bytes，
    // 供后续 chat 路由按 fileId 反查到完整文件元信息（替代旧的前端 uploadedFiles 透传）。
    const mimeType = file.type || 'application/octet-stream';
    const sizeBytes = buffer.length;
    await query(
      `
        INSERT INTO file_content (
          minio_bucket, minio_key, status, file_id, filename, mime_type, size_bytes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [process.env.MINIO_BUCKET!, minioKey, 'parsing', fileId, file.name, mimeType, sizeBytes],
    );

    // 解析文件内容
    try {
      const content = await extractTextFromFile(
        process.env.MINIO_BUCKET!,
        minioKey,
        mimeType,
        file.name,
      );

      // 更新file_content表，保存解析结果
      await query(
        `
          UPDATE file_content
          SET content = $1, status = $2, updated_at = now()
          WHERE minio_key = $3
        `,
        [content, 'success', minioKey],
      );

      return NextResponse.json(
        {
          fileId,
          minioKey,
          filename: file.name,
          mimeType,
          sizeBytes,
          content: content.substring(0, 200) + (content.length > 200 ? '...' : ''),
        },
        { status: 200 },
      );
    } catch (parseError: any) {
      console.error('Parse error:', parseError);

      // 更新file_content表，记录解析失败
      await query(
        `
          UPDATE file_content
          SET status = $1, error_message = $2, updated_at = now()
          WHERE minio_key = $3
        `,
        ['failed', parseError.message, minioKey],
      );

      return NextResponse.json(
        {
          fileId,
          minioKey,
          filename: file.name,
          mimeType,
          sizeBytes,
          error: parseError.message,
        },
        { status: 200 },
      );
    }
  } catch (error: any) {
    console.error('Upload error:', error);

    // 如果上传失败，清理已上传的文件
    if (uploadedKey) {
      try {
        const { deleteFile } = await import('@/lib/storage');
        await deleteFile(uploadedKey);
      } catch (cleanupError) {
        console.error('Failed to cleanup uploaded file:', cleanupError);
      }
    }

    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
