/**
 * /api/model-keys/[provider] —— 删除本人某 provider 的 API Key。
 *
 * 安全：getCurrentUser 鉴权；仅删除 user_id = 当前用户 的记录（按本人隔离）。
 */

import { NextRequest, NextResponse } from 'next/server';

import { getCurrentUser, toHttpError } from '@/server/http';
import { getModelKeyService } from '@/server/services/model-key-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(request: NextRequest, { params }: { params: { provider: string } }) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  try {
    await getModelKeyService().deleteKey(user.id, params.provider);
    return NextResponse.json({ message: 'Delete model key success!' }, { status: 200 });
  } catch (error) {
    console.error('[model-keys] delete error for provider:', params.provider, error);
    return toHttpError(error, 'Delete model key failed');
  }
}
