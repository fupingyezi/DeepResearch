/**
 * /api/model-keys —— 用户级模型 API Key 管理。
 *
 * - GET   : 返回本人已配置的 provider + 掩码，以及当前选用模型（绝不返回明文 Key）。
 * - PUT   : 保存 / 覆盖某 provider 的 API Key（加密落库）。body: { provider, apiKey }
 * - PATCH : 设置当前选用模型预设。body: { selectedModel }（必须是其 provider 已配置 Key 的预设）
 *
 * 安全：全程 getCurrentUser 鉴权；所有读写按本人 user_id 隔离；明文 Key 永不回显。
 */

import { NextRequest, NextResponse } from 'next/server';

import { getCurrentUser, toHttpError } from '@/server/http';
import { getModelKeyService } from '@/server/services/model-key-service';
import { parseJsonBody } from '@/server/validation';
import { patchSelectedModelSchema, putModelKeySchema } from '@/server/validation/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET：已配置 provider + 掩码 + 当前选用模型。 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  try {
    const data = await getModelKeyService().list(user.id);
    return NextResponse.json({ message: 'Get model keys success!', data }, { status: 200 });
  } catch (error) {
    console.error('[model-keys] get error:', error);
    return toHttpError(error, 'Get model keys failed');
  }
}

/** PUT：保存某 provider 的 API Key。 */
export async function PUT(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const parsed = await parseJsonBody(request, putModelKeySchema);
  if (!parsed.ok) return parsed.response;

  try {
    const data = await getModelKeyService().saveKey(
      user.id,
      parsed.data.provider,
      parsed.data.apiKey,
    );
    return NextResponse.json({ message: 'Save model key success!', data }, { status: 200 });
  } catch (error) {
    console.error('[model-keys] put error for provider:', parsed.data.provider, error);
    return toHttpError(error, 'Save model key failed');
  }
}

/** PATCH：设置当前选用模型预设（要求其 provider 已配置 Key）。 */
export async function PATCH(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const parsed = await parseJsonBody(request, patchSelectedModelSchema);
  if (!parsed.ok) return parsed.response;

  try {
    await getModelKeyService().selectModel(user.id, parsed.data.selectedModel);
    return NextResponse.json(
      {
        message: 'Set selected model success!',
        data: { selectedModel: parsed.data.selectedModel },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('[model-keys] patch error:', error);
    return toHttpError(error, 'Set selected model failed');
  }
}
