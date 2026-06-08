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

import {
  listConfiguredProviders,
  upsertModelKey,
  getSelectedModel,
  setSelectedModel,
} from '@deerflow-harness/auth';
import { MODEL_PRESETS, type ModelPresetName } from '@/config/models';
import { getCurrentUser } from '../auth/_helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 从预设集合派生出受支持的 provider 白名单，避免写入非法 provider。 */
const VALID_PROVIDERS = new Set<string>(
  Object.values(MODEL_PRESETS).map((preset) => preset.provider),
);

/** GET：已配置 provider + 掩码 + 当前选用模型。 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  try {
    const [configured, selectedModel] = await Promise.all([
      listConfiguredProviders(user.id),
      getSelectedModel(user.id),
    ]);
    return NextResponse.json(
      { message: 'Get model keys success!', data: { configured, selectedModel } },
      { status: 200 },
    );
  } catch (error) {
    console.error('[model-keys] get error:', error);
    return NextResponse.json({ message: 'Get model keys failed!' }, { status: 500 });
  }
}

interface PutBody {
  provider?: string;
  apiKey?: string;
}

/** PUT：保存某 provider 的 API Key。 */
export async function PUT(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return NextResponse.json({ message: 'Invalid JSON body' }, { status: 400 });
  }

  const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';

  if (!provider || !VALID_PROVIDERS.has(provider)) {
    return NextResponse.json({ message: 'Invalid or unsupported provider' }, { status: 400 });
  }
  if (!apiKey) {
    return NextResponse.json({ message: 'Field "apiKey" is required' }, { status: 400 });
  }

  try {
    const data = await upsertModelKey(user.id, provider, apiKey);
    return NextResponse.json({ message: 'Save model key success!', data }, { status: 200 });
  } catch {
    console.error('[model-keys] put error for provider:', provider);
    return NextResponse.json({ message: 'Save model key failed!' }, { status: 500 });
  }
}

interface PatchBody {
  selectedModel?: string;
}

/** PATCH：设置当前选用模型预设（要求其 provider 已配置 Key）。 */
export async function PATCH(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ message: 'Invalid JSON body' }, { status: 400 });
  }

  const selectedModel = typeof body.selectedModel === 'string' ? body.selectedModel.trim() : '';
  const preset = MODEL_PRESETS[selectedModel as ModelPresetName];
  if (!preset) {
    return NextResponse.json({ message: 'Invalid model preset' }, { status: 400 });
  }

  try {
    // 校验该预设对应 provider 已配置 Key，避免选中一个无法使用的模型。
    const configured = await listConfiguredProviders(user.id);
    const hasKey = configured.some((c) => c.provider === preset.provider);
    if (!hasKey) {
      return NextResponse.json(
        { message: `Provider "${preset.provider}" has no API key configured` },
        { status: 400 },
      );
    }

    await setSelectedModel(user.id, selectedModel);
    return NextResponse.json(
      { message: 'Set selected model success!', data: { selectedModel } },
      { status: 200 },
    );
  } catch (error) {
    console.error('[model-keys] patch error:', error);
    return NextResponse.json({ message: 'Set selected model failed!' }, { status: 500 });
  }
}
