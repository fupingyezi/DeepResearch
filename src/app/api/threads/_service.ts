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
  type ThreadService,
  type ModelConfig,
} from '@/deerflow-harness';
import {
  buildModelConfigFromPreset,
  resolveModelConfig,
  MODEL_PRESETS,
  type ModelPresetName,
} from '@/config/models';

let service: ThreadService | null = null;
let initPromise: Promise<ThreadService> | null = null;
let memoryFactoryRegistered = false;

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
 * 兼容直接传入 ModelPresetName 字符串的旧调用风格（仅供内部 helper 复用）。
 */
function resolveModelConfigFromConfiguration(
  configuration?: { model?: { value?: string } } | null,
): ModelConfig {
  const value = configuration?.model?.value;
  if (typeof value === 'string' && value.length > 0) {
    try {
      return buildModelConfigFromPreset(value as ModelPresetName);
    } catch (e) {
      console.warn('[resolveModelConfigFromConfiguration] Failed to resolve preset key:', e);
      return getDefaultModelConfig();
    }
  }
  return getDefaultModelConfig();
}

async function build(): Promise<ThreadService> {
  const { saver: checkpointer } = await makeCheckpointer({ kind: 'postgres' });

  ensureMemoryModelFactory();

  const defaultModelConfig = getDefaultModelConfig();
  const client = new DeerFlowClient(defaultModelConfig, {
    agentName: 'lead',
    memoryEnabled: true,
    checkpointer,
  });

  return createThreadService({
    client,
    checkpointer,
    threads: new PgThreadMetaStore(),
    runs: new PgRunStore(),
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

/**
 * 按 configuration 动态构造一个 DeerFlowClient（用于一次性切换模型的请求）。
 */
export async function getDeerFlowClientWithModelConfig(
  configuration?: { model?: { value?: string } } | null,
): Promise<DeerFlowClient> {
  const modelConfig = resolveModelConfigFromConfiguration(configuration);
  const { saver: checkpointer } = await makeCheckpointer({ kind: 'postgres' });

  ensureMemoryModelFactory();

  return new DeerFlowClient(modelConfig, {
    agentName: 'lead',
    memoryEnabled: true,
    checkpointer,
  });
}
