/**
 * 模型配置解析服务。
 *
 * 两条链路：
 * - resolveModelConfigFromConfiguration：从 env 注入 apiKey，仅保留给副链路 / 兼容用途
 * - resolveUserModelConfig：按「当前登录用户」解析主聊天链路的 ModelConfig（用户自带 Key）
 */

import { getDecryptedKey, getSelectedModel } from '@deerflow-harness/auth';
import {
  buildModelConfigFromPreset,
  buildModelConfigForUser,
  MODEL_PRESETS,
  type ModelPresetName,
} from '@/config/models';
import type { ModelConfig } from '@/deerflow-harness';

/**
 * 从请求 body 的 configuration 中解析 modelConfig：
 * - body.configuration.model.value: string  → 在 MODEL_PRESETS 中查找
 *
 * 返回 null 表示请求未指定模型（由调用方决定走默认 client）。
 *
 * 注意：此函数从环境变量注入 apiKey，仅保留给副链路 / 兼容用途；
 * 主聊天链路应改用 resolveUserModelConfig（按当前用户解密 Key 注入）。
 */
export function resolveModelConfigFromConfiguration(
  configuration?: { model?: { value?: string } } | null,
): ModelConfig | null {
  const value = configuration?.model?.value;
  if (typeof value === 'string' && value.length > 0) {
    try {
      return buildModelConfigFromPreset(value as ModelPresetName);
    } catch (e) {
      console.warn('[resolveModelConfigFromConfiguration] Failed to resolve preset key:', e);
      return null;
    }
  }
  return null;
}

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
