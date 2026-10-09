import { NextResponse } from 'next/server';

import { withApiHandler } from '@/server/http';
import { getExtensionService } from '@/server/services/extension-service';
import { patchEnabledSchema } from '@/server/validation/schemas';

export { OPTIONS } from '@/server/http/preflight';

export const runtime = 'nodejs';

/** 切换某个 skill 的启用状态。 */
export const PATCH = withApiHandler(
  { body: patchEnabledSchema, fallbackMessage: 'Update skill failed' },
  async ({ body, params }) => {
    const skill = await getExtensionService().setSkillEnabled(params.name, body.enabled);
    return NextResponse.json({ message: 'Update skill success!', data: skill }, { status: 200 });
  },
);
