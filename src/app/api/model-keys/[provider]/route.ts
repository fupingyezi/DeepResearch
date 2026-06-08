/**
 * /api/model-keys/[provider] —— 删除本人某 provider 的 API Key。
 *
 * 安全：getCurrentUser 鉴权；仅删除 user_id = 当前用户 的记录（按本人隔离）。
 */

import { NextRequest, NextResponse } from 'next/server';

import { deleteModelKey } from '@deerflow-harness/auth';
import { MODEL_PRESETS } from '@/config/models';
import { getCurrentUser } from '../../auth/_helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_PROVIDERS = new Set<string>(
  Object.values(MODEL_PRESETS).map((preset) => preset.provider),
);

export async function DELETE(
  request: NextRequest,
  { params }: { params: { provider: string } },
) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const provider = params.provider?.trim();
  if (!provider || !VALID_PROVIDERS.has(provider)) {
    return NextResponse.json({ message: 'Invalid or unsupported provider' }, { status: 400 });
  }

  try {
    await deleteModelKey(user.id, provider);
    return NextResponse.json({ message: 'Delete model key success!' }, { status: 200 });
  } catch {
    console.error('[model-keys] delete error for provider:', provider);
    return NextResponse.json({ message: 'Delete model key failed!' }, { status: 500 });
  }
}
