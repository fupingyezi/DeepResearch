/**
 * POST /api/prompt/enhance —— 提示词增强（输入框星星按钮）。
 *
 * 需登录（会话 cookie）；输入非空且 ≤ 8000 字符；输出仅返回改写后的提示词。
 */

import { NextRequest, NextResponse } from 'next/server';

import { getCurrentUser, toHttpError } from '@/server/http';
import { getPromptEnhanceService } from '@/server/services/prompt-enhance-service';
import { parseJsonBody } from '@/server/validation';
import { enhancePromptSchema } from '@/server/validation/schemas';

export async function POST(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const parsed = await parseJsonBody(request, enhancePromptSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const enhanced = await getPromptEnhanceService().enhance(parsed.data.input);
    return NextResponse.json({ enhanced });
  } catch (error) {
    return toHttpError(error, '增强失败');
  }
}
