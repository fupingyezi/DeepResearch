import { NextRequest, NextResponse } from 'next/server';

import { getCurrentUser, toHttpError } from '@/server/http';
import { getExtensionService } from '@/server/services/extension-service';
import { parseJsonBody } from '@/server/validation';
import { patchEnabledSchema } from '@/server/validation/schemas';

export const runtime = 'nodejs';

/** 切换某个 skill 的启用状态。 */
export async function PATCH(request: NextRequest, { params }: { params: { name: string } }) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const parsed = await parseJsonBody(request, patchEnabledSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const skill = await getExtensionService().setSkillEnabled(params.name, parsed.data.enabled);
    return NextResponse.json({ message: 'Update skill success!', data: skill }, { status: 200 });
  } catch (error) {
    console.error('[skills] patch error:', error);
    return toHttpError(error, 'Update skill failed');
  }
}
