import { NextResponse } from 'next/server';

import { withApiHandler } from '@/server/http';
import { getFileService } from '@/server/services/file-service';
import { fileIdBodySchema } from '@/server/validation/schemas';

export const DELETE = withApiHandler({ auth: 'none', body: fileIdBodySchema }, async ({ body }) => {
  await getFileService().deleteUploadedFile(body.fileId);

  return NextResponse.json({
    success: true,
    message: 'File deleted successfully',
  });
});
