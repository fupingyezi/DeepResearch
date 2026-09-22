/**
 * /api/model-keys —— 用户级模型 API Key 管理。
 *
 * - GET   : 返回本人已配置的 provider + 掩码，以及当前选用模型（绝不返回明文 Key）。
 * - PUT   : 保存 / 覆盖某 provider 的 API Key（加密落库）。body: { provider, apiKey }
 * - PATCH : 设置当前选用模型预设。body: { selectedModel }（必须是其 provider 已配置 Key 的预设）
 *
 * 安全：全程 getCurrentUser 鉴权；所有读写按本人 user_id 隔离；明文 Key 永不回显。
 */

import { NextResponse } from 'next/server';

import { withApiHandler } from '@/server/http';
import { getModelKeyService } from '@/server/services/model-key-service';
import { patchSelectedModelSchema, putModelKeySchema } from '@/server/validation/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET：已配置 provider + 掩码 + 当前选用模型。 */
export const GET = withApiHandler(
  { fallbackMessage: 'Get model keys failed' },
  async ({ user }) => {
    const data = await getModelKeyService().list(user!.id);
    return NextResponse.json({ message: 'Get model keys success!', data }, { status: 200 });
  },
);

/** PUT：保存某 provider 的 API Key。 */
export const PUT = withApiHandler(
  { body: putModelKeySchema, fallbackMessage: 'Save model key failed' },
  async ({ user, body }) => {
    const data = await getModelKeyService().saveKey(user!.id, body.provider, body.apiKey);
    return NextResponse.json({ message: 'Save model key success!', data }, { status: 200 });
  },
);

/** PATCH：设置当前选用模型预设（要求其 provider 已配置 Key）。 */
export const PATCH = withApiHandler(
  { body: patchSelectedModelSchema, fallbackMessage: 'Set selected model failed' },
  async ({ user, body }) => {
    await getModelKeyService().selectModel(user!.id, body.selectedModel);
    return NextResponse.json(
      {
        message: 'Set selected model success!',
        data: { selectedModel: body.selectedModel },
      },
      { status: 200 },
    );
  },
);
