/**
 * threadService 全局单例
 *
 * 支持两种模式：
 * 1. 基础单例模式（缓存 DeerFlowClient）
 * 2. 动态模型模式：通过 body.configuration.model.value 在请求时传递
 */

import {
  DeerFlowClient,
  PgRunStore,
  PgThreadMetaStore,
  createChatModel,
  createThreadService,
  makeCheckpointer,
  setMemoryModelFactory,
  setTitleModelFactory,
  type ThreadService,
  type ModelConfig,
} from '@/deerflow-harness';
import {
  buildModelConfigFromPreset,
  buildModelConfigForUser,
  resolveModelConfig,
  MODEL_PRESETS,
  type ModelPresetName,
} from '@/config/models';
import { getDecryptedKey, getSelectedModel } from '@deerflow-harness/auth';

let service: ThreadService | null = null;
let initPromise: Promise<ThreadService> | null = null;
let memoryFactoryRegistered = false;
let titleFactoryRegistered = false;

/**
 * 把 chat model 工厂注入给 memory 子系统（updater）。
 * 只需注入一次；若 factory 未注入，updater 会跳过 LLM 提炼直接返回 false。
 */
function ensureMemoryModelFactory(): void {
  if (memoryFactoryRegistered) return;
  setMemoryModelFactory((modelName) => {
    let base: ModelConfig;
    if (modelName && MODEL_PRESETS[modelName as ModelPresetName]) {
      base = buildModelConfigFromPreset(modelName as ModelPresetName);
    } else if (modelName) {
      const fallback = resolveModelConfig();
      base = { ...fallback, modelName };
    } else {
      base = resolveModelConfig();
    }
    return createChatModel({
      ...base,
      streaming: false,
      maxTokens: 8192,
      temperature: 0.2,
      topP: 0.8,
    });
  });
  memoryFactoryRegistered = true;
}

/**
 * 把 chat model 工厂注入给 titleMiddleware。
 */
function ensureTitleModelFactory(): void {
  if (titleFactoryRegistered) return;
  setTitleModelFactory((modelName) => {
    let base: ModelConfig;
    if (modelName && MODEL_PRESETS[modelName as ModelPresetName]) {
      base = buildModelConfigFromPreset(modelName as ModelPresetName);
    } else if (modelName) {
      const fallback = resolveModelConfig();
      base = { ...fallback, modelName };
    } else {
      base = resolveModelConfig();
    }
    return createChatModel({
      ...base,
      streaming: false,
      maxTokens: 64,
      temperature: 0.3,
      topP: 0.8,
    });
  });
  titleFactoryRegistered = true;
}

/**
 * 默认 ModelConfig：走 resolveModelConfig() 的默认 preset；apiKey/baseUrl
 * 由 buildModelConfigFromPreset 按 provider 注入。
 */
function getDefaultModelConfig(): ModelConfig {
  return resolveModelConfig();
}

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

async function build(): Promise<ThreadService> {
  const { saver: checkpointer } = await makeCheckpointer({ kind: 'postgres' });

  ensureMemoryModelFactory();
  ensureTitleModelFactory();

  const defaultModelConfig = getDefaultModelConfig();

  // 服务级默认 features：
  //   - memoryEnabled:    true  → 长期记忆默认开启；可被 metadata 覆盖。
  //   - autoTitleEnabled: true  → 首轮后异步生成会话标题（替代占位 "New thread"）。
  //   - threadDataEnabled: true → 装载本会话上传文件到 state（基础设施）。
  //   - uploadsEnabled:   true  → 把上传文件以 SystemMessage 注入 prompt 上下文。
  //   - sandboxEnabled:   true  → 获取沙箱并注入文件工具集（bash 默认禁用，需 env 开启）。
  // 单次请求可通过 body.configuration.<key> 显式覆盖（见 v3/chat route.ts）。
  const sharedClientOptions = {
    agentName: 'lead' as const,
    memoryEnabled: true,
    autoTitleEnabled: true,
    threadDataEnabled: true,
    uploadsEnabled: true,
    sandboxEnabled: true,
    checkpointer,
  };

  const client = new DeerFlowClient(defaultModelConfig, sharedClientOptions);

  // 按模型名缓存 client，供 submitRun 在单次请求切换模型时复用（避免每请求新建丢失 agentCache）。
  const clientByModel = new Map<string, DeerFlowClient>();
  const createClientForModel = (modelConfig: ModelConfig): DeerFlowClient => {
    const cached = clientByModel.get(modelConfig.modelName);
    if (cached) return cached;
    const next = new DeerFlowClient(modelConfig, sharedClientOptions);
    clientByModel.set(modelConfig.modelName, next);
    return next;
  };

  return createThreadService({
    client,
    checkpointer,
    threads: new PgThreadMetaStore(),
    runs: new PgRunStore(),
    createClientForModel,
  });
}

export async function getThreadService(): Promise<ThreadService> {
  if (service) return service;
  if (!initPromise) {
    initPromise = build().then((s) => {
      service = s;
      return s;
    });
  }
  return initPromise;
}
