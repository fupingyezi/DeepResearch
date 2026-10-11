/**
 * prompt 域 HTTP 层逻辑（自 route.ts 抽出）；route.ts 是薄适配器。
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { ApiRouteHandler } from '@/backend/http';
import { getPromptEnhanceService } from '@/backend/services/prompt-enhance-service';
import { enhancePromptSchema } from '@/backend/validation/schemas';

/**
 * POST /api/prompt/enhance —— 提示词增强（输入框星星按钮）。
 *
 * 需登录（会话 cookie）；输入非空且 ≤ 8000 字符；输出仅返回改写后的提示词。
 */
export const enhance: ApiRouteHandler<z.infer<typeof enhancePromptSchema>, undefined> = async ({
  body,
}) => {
  const enhanced = await getPromptEnhanceService().enhance(body.input);
  return NextResponse.json({ enhanced });
};

export const promptController = { enhance };
