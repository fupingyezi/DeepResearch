/**
 * model-keys 域 HTTP 层逻辑（自 route.ts 抽出）：用户级模型 API Key 管理。
 *
 * - GET   : 返回本人已配置的 provider + 掩码，以及当前选用模型（绝不返回明文 Key）。
 * - PUT   : 保存 / 覆盖某 provider 的 API Key（加密落库）。body: { provider, apiKey }
 * - PATCH : 设置当前选用模型预设。body: { selectedModel }（必须是其 provider 已配置 Key 的预设）
 * - DELETE: 删除本人某 provider 的 API Key（/api/model-keys/[provider]）。
 *
 * 安全：全程 getCurrentUser 鉴权；所有读写按本人 user_id 隔离；明文 Key 永不回显。
 *
 * route.ts（/api/model-keys 与 /api/model-keys/[provider]）是薄适配器，只保留
 * withApiHandler 选项与 Next 配置导出（runtime / dynamic），不再含业务 handler 体。
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { ApiRouteHandler } from '@/backend/http';
import { getModelKeyService } from '@/backend/services/model-key-service';
import { patchSelectedModelSchema, putModelKeySchema } from '@/backend/validation/schemas';

/** GET：已配置 provider + 掩码 + 当前选用模型。 */
export const list: ApiRouteHandler<undefined, undefined> = async ({ user }) => {
  const data = await getModelKeyService().list(user!.id);
  return NextResponse.json({ message: 'Get model keys success!', data }, { status: 200 });
};

/** PUT：保存某 provider 的 API Key。 */
export const saveKey: ApiRouteHandler<z.infer<typeof putModelKeySchema>, undefined> = async ({
  user,
  body,
}) => {
  const data = await getModelKeyService().saveKey(user!.id, body.provider, body.apiKey);
  return NextResponse.json({ message: 'Save model key success!', data }, { status: 200 });
};

/** PATCH：设置当前选用模型预设（要求其 provider 已配置 Key）。 */
export const selectModel: ApiRouteHandler<
  z.infer<typeof patchSelectedModelSchema>,
  undefined
> = async ({ user, body }) => {
  await getModelKeyService().selectModel(user!.id, body.selectedModel);
  return NextResponse.json(
    {
      message: 'Set selected model success!',
      data: { selectedModel: body.selectedModel },
    },
    { status: 200 },
  );
};

/** DELETE：删除本人某 provider 的 API Key（仅删除 user_id = 当前用户 的记录）。 */
export const deleteKey: ApiRouteHandler<undefined, undefined> = async ({ user, params }) => {
  await getModelKeyService().deleteKey(user!.id, params.provider);
  return NextResponse.json({ message: 'Delete model key success!' }, { status: 200 });
};

export const modelKeysController = { list, saveKey, selectModel, deleteKey };
