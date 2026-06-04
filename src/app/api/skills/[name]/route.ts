import { NextRequest, NextResponse } from 'next/server';

import { getExtensionsConfigStore } from '@/deerflow-harness';
import { getCurrentUser } from '../../auth/_helpers';

export const runtime = 'nodejs';

interface PatchSkillBody {
  enabled?: boolean;
}

/** 切换某个 skill 的启用状态。 */
export async function PATCH(request: NextRequest, { params }: { params: { name: string } }) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  let body: PatchSkillBody;
  try {
    body = (await request.json()) as PatchSkillBody;
  } catch {
    return NextResponse.json({ message: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json({ message: 'Field "enabled" (boolean) is required' }, { status: 400 });
  }

  try {
    const config = await getExtensionsConfigStore().setSkillEnabled(params.name, body.enabled);
    return NextResponse.json(
      { message: 'Update skill success!', data: config.skills[params.name] },
      { status: 200 },
    );
  } catch (error) {
    console.error('[skills] patch error:', error);
    return NextResponse.json(
      {
        message: 'Update skill failed!',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
