import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { deleteFile } from '@/lib/storage';

export async function DELETE(request: NextRequest) {
  try {
    const { fileId } = await request.json();

    if (!fileId) {
      return NextResponse.json({ error: 'Missing fileId' }, { status: 400 });
    }

    // 首先尝试从file_metadata表获取文件信息
    const metadataResult = await query('SELECT * FROM file_metadata WHERE id = $1', [fileId]);

    let minioKey = null;

    if (metadataResult.rows.length > 0) {
      // 如果在file_metadata中找到，使用其minio_key
      const fileMetadata = metadataResult.rows[0];
      minioKey = fileMetadata.minio_key;

      // 删除file_metadata记录
      await query('DELETE FROM file_metadata WHERE id = $1', [fileId]);
    } else {
      // 如果在file_metadata中没找到，可能文件还没有插入元数据，尝试从file_content表查找
      // 这种情况下，fileId可能就是minioKey的一部分，我们需要查找包含fileId的记录
      const contentResult = await query(
        'SELECT minio_key FROM file_content WHERE minio_key LIKE $1',
        [`%${fileId}%`],
      );

      if (contentResult.rows.length > 0) {
        minioKey = contentResult.rows[0].minio_key;
      }
    }

    if (minioKey) {
      // 删除MinIO中的文件
      try {
        await deleteFile(minioKey);
      } catch (storageError) {
        console.warn('Failed to delete from storage:', storageError);
      }

      // 删除file_content记录
      await query('DELETE FROM file_content WHERE minio_key = $1', [minioKey]);
    }

    return NextResponse.json({
      success: true,
      message: 'File deleted successfully',
    });
  } catch (error: any) {
    console.error('Delete error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
