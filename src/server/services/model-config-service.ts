/**
 * 模型配置解析服务。
 *
 * 单一链路：按「当前登录用户」解析主聊天链路的 ModelConfig（用户自带 Key）。
 */

import { getDecryptedKey, getSelectedModel } from '@deerflow-harness/auth';
import { buildModelConfigForUser, MODEL_PRESETS, type ModelPresetName } from '@/config/models';
import type { ModelConfig } from '@/deerflow-harness';

/**
 * 用户感知的模型解析结果（discriminated union）。
 * 调用方据此决定放行或返回 4xx 引导用户去「设置-模型管理」配置。
 */
export type UserModelResolution =
  | { ok: true; modelConfig: ModelConfig; presetKey: ModelPresetName }
  | { ok: false; reason: 'NO_MODEL' }
  | { ok: false; reason: 'NO_KEY'; provider: string };

/**
 * 按「当前登录用户」解析主聊天链路的 ModelConfig：
 *  1. 选定预设：请求显式指定（configuration.model.value）优先，其次用户落库的 selectedModel。
 *  2. 取该预设 provider 的用户加密 Key 并解密。
 *  3. 无预设 → NO_MODEL；无 Key → NO_KEY（携带 provider 供前端提示）。
 *
 * 不再使用环境变量默认 Key —— 体现「不再内置默认 Key、由用户自带 Key」。
 */
export async function resolveUserModelConfig(
  userId: string,
  configuration?: { model?: { value?: string } } | null,
): Promise<UserModelResolution> {
  let presetKey: ModelPresetName | null = null;

  const explicit = configuration?.model?.value;
  if (typeof explicit === 'string' && MODEL_PRESETS[explicit as ModelPresetName]) {
    presetKey = explicit as ModelPresetName;
  } else {
    const selected = await getSelectedModel(userId);
    if (selected && MODEL_PRESETS[selected as ModelPresetName]) {
      presetKey = selected as ModelPresetName;
    }
  }

  if (!presetKey) return { ok: false, reason: 'NO_MODEL' };

  const preset = MODEL_PRESETS[presetKey];
  const apiKey = await getDecryptedKey(userId, preset.provider);
  if (!apiKey) return { ok: false, reason: 'NO_KEY', provider: preset.provider };

  return { ok: true, modelConfig: buildModelConfigForUser(presetKey, apiKey), presetKey };
}
