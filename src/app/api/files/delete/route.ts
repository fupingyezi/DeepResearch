import { NextResponse } from 'next/server';

import { withApiHandler } from '@/server/http';
import { getFileService } from '@/server/services/file-service';
import { fileIdBodySchema } from '@/server/validation/schemas';

export const DELETE = withApiHandler({ body: fileIdBodySchema }, async ({ body, user }) => {
  await getFileService().deleteUploadedFile(body.fileId, user!.id);

  return NextResponse.json({
    success: true,
    message: 'File deleted successfully',
  });
});
