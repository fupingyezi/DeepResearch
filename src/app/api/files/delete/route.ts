import { NextRequest, NextResponse } from 'next/server';

import { toHttpError } from '@/server/http';
import { getFileService } from '@/server/services/file-service';
import { parseJsonBody } from '@/server/validation';
import { fileIdBodySchema } from '@/server/validation/schemas';

export async function DELETE(request: NextRequest) {
  try {
    const parsed = await parseJsonBody(request, fileIdBodySchema);
    if (!parsed.ok) return parsed.response;

    await getFileService().deleteUploadedFile(parsed.data.fileId);

    return NextResponse.json({
      success: true,
      message: 'File deleted successfully',
    });
  } catch (error) {
    console.error('Delete error:', error);
    return toHttpError(error);
  }
}
