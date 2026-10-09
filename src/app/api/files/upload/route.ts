import { NextResponse, type NextRequest } from 'next/server';

import { ensureBucket } from '@/lib';
import { jsonError, withApiHandler } from '@/server/http';
import { getFileService } from '@/server/services/file-service';
import type { ParseResult } from '@/server/validation';

/**
 * multipart 自定义解析：ensureBucket 必须最先执行（现状顺序：ensureBucket →
 * formData → 校验 → upload，倒置会让桶不存在时先读 body 抛 500）。
 */
async function parseUploadBody(
  request: NextRequest,
): Promise<ParseResult<{ file: File; fileId: string }>> {
  await ensureBucket();

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  const fileId = formData.get('fileId') as string;

  if (!file || !fileId) {
    return { ok: false, response: jsonError('INVALID_INPUT', 'Missing file or fileId', 400) };
  }
  return { ok: true, data: { file, fileId } };
}

export const POST = withApiHandler({ body: parseUploadBody }, async ({ body, user }) => {
  const result = await getFileService().uploadFile(body.file, body.fileId, user!.id);
  return NextResponse.json(result, { status: 200 });
});
