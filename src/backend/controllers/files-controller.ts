/**
 * files 域 HTTP 层逻辑（自 route.ts 抽出）；route.ts 是薄适配器。
 *
 * 覆盖 /api/files/upload 与 /api/files/delete 两个路由的 handler，以及
 * upload 的 multipart 自定义解析（route.ts 继续以它作 body 选项）。
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { jsonError, type ApiRouteHandler } from '@/backend/http';
import { ensureBucket } from '@/backend/lib/storage';
import { getFileService } from '@/backend/services/file-service';
import { fileIdBodySchema } from '@/backend/validation/schemas';
import type { ParseResult } from '@/backend/validation';

/**
 * multipart 自定义解析：ensureBucket 必须最先执行（现状顺序：ensureBucket →
 * formData → 校验 → upload，倒置会让桶不存在时先读 body 抛 500）。
 */
export async function parseUploadBody(
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

export const upload: ApiRouteHandler<{ file: File; fileId: string }, undefined> = async ({
  body,
  user,
}) => {
  const result = await getFileService().uploadFile(body.file, body.fileId, user!.id);
  return NextResponse.json(result, { status: 200 });
};

export const deleteFile: ApiRouteHandler<z.infer<typeof fileIdBodySchema>, undefined> = async ({
  body,
  user,
}) => {
  await getFileService().deleteUploadedFile(body.fileId, user!.id);

  return NextResponse.json({
    success: true,
    message: 'File deleted successfully',
  });
};
