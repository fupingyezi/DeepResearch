import { NextRequest, NextResponse } from 'next/server';

import { ensureBucket } from '@/lib';
import { toHttpError } from '@/server/http';
import { getFileService } from '@/server/services/file-service';

export async function POST(request: NextRequest) {
  try {
    await ensureBucket();

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const fileId = formData.get('fileId') as string;

    if (!file || !fileId) {
      return NextResponse.json({ error: 'Missing file or fileId' }, { status: 400 });
    }

    const result = await getFileService().uploadFile(file, fileId);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error('[POST /api/files/upload] error:', error);
    return toHttpError(error);
  }
}
