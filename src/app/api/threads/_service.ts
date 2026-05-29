/**
 * threadService 全局单例
 *
 * 支持两种模式：
 * 1. 基础单例模式（缓存 DeerFlowClient）
 * 2. 动态模型模式：通过 metadata.modelKey 或 metadata.modelConfig 在请求时传递
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
  type ModelPresetKey,
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
    if (modelName && MODEL_PRESETS[modelName as ModelPresetKey]) {
      base = buildModelConfigFromPreset(modelName as ModelPresetKey);
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
 * 从请求 metadata 中解析 modelConfig：
 * - metadata.modelKey: string  → 在 MODEL_PRESETS 中查找
 * - metadata.modelConfig: ModelConfig → 直接使用
 */
function resolveModelConfigFromMetadata(metadata?: Record<string, any>): ModelConfig {
  if (!metadata) return getDefaultModelConfig();

  if (typeof metadata.modelKey === 'string') {
    try {
      return buildModelConfigFromPreset(metadata.modelKey as ModelPresetKey);
    } catch (e) {
      console.warn('[resolveModelConfigFromMetadata] Failed to resolve preset key:', e);
      return getDefaultModelConfig();
    }
  }

  if (metadata.modelConfig && typeof metadata.modelConfig === 'object') {
    return metadata.modelConfig as ModelConfig;
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
 * 按 metadata 动态构造一个 DeerFlowClient（用于一次性切换模型的请求）。
 */
export async function getDeerFlowClientWithModelConfig(
  metadata?: Record<string, any>,
): Promise<DeerFlowClient> {
  const modelConfig = resolveModelConfigFromMetadata(metadata);
  const { saver: checkpointer } = await makeCheckpointer({ kind: 'postgres' });

  ensureMemoryModelFactory();

  return new DeerFlowClient(modelConfig, {
    agentName: 'lead',
    memoryEnabled: true,
    checkpointer,
  });
}
