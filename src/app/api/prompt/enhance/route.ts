/**
 * POST /api/prompt/enhance —— 提示词增强（输入框星星按钮）。
 *
 * 需登录（会话 cookie）；输入非空且 ≤ 8000 字符；输出仅返回改写后的提示词。
 */

import { NextResponse } from 'next/server';

import { withApiHandler } from '@/server/http';
import { getPromptEnhanceService } from '@/server/services/prompt-enhance-service';
import { enhancePromptSchema } from '@/server/validation/schemas';

export const POST = withApiHandler(
  { body: enhancePromptSchema, fallbackMessage: '增强失败' },
  async ({ body }) => {
    const enhanced = await getPromptEnhanceService().enhance(body.input);
    return NextResponse.json({ enhanced });
  },
);
