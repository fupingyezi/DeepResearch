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
    // 1) 默认走全局默认 preset（deepseek-v4-flash）
    // 2) 若 caller 显式传 modelName，先尝试当作 preset key 解析；
    //    解析不到再回退为「按 modelName 直接构造」+ 默认 DeepSeek 凭据
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
 * 获取默认的 ModelConfig（用于基础模式或无指定时）
 * 统一走 resolveModelConfig() —— 默认 preset 为 deepseek-v4-flash，
 * apiKey/baseUrl 由 buildModelConfigFromPreset 按 provider 注入。
 */
function getDefaultModelConfig(): ModelConfig {
  return resolveModelConfig();
}

/**
 * 从请求元数据中解析 modelConfig
 * 支持两种格式：
 * 1. metadata.modelKey: string（如 'deepseek-v4-pro'）- 从 MODEL_PRESETS 查找
 * 2. metadata.modelConfig: ModelConfig（完整配置）- 直接使用
 */
function resolveModelConfigFromMetadata(metadata?: Record<string, any>): ModelConfig {
  if (!metadata) return getDefaultModelConfig();

  // 方式 1：使用预设的模型 key
  if (typeof metadata.modelKey === 'string') {
    try {
      return buildModelConfigFromPreset(metadata.modelKey as ModelPresetKey);
    } catch (e) {
      console.warn('[resolveModelConfigFromMetadata] Failed to resolve preset key:', e);
      return getDefaultModelConfig();
    }
  }

  // 方式 2：直接传入完整的 ModelConfig
  if (metadata.modelConfig && typeof metadata.modelConfig === 'object') {
    return metadata.modelConfig as ModelConfig;
  }

  return getDefaultModelConfig();
}

async function build(): Promise<ThreadService> {
  const { saver: checkpointer } = await makeCheckpointer({ kind: 'postgres' });

  ensureMemoryModelFactory();

  const defaultModelConfig = getDefaultModelConfig();
  // deer-flow 2.0 风格：lead-agent 永远启用 subagent 能力（subagentEnabled 字段
  // 已 deprecated，保留传值仅为旧 ClientOptions 字段穿透不报错；实际行为由
  // factory 始终注入 taskTool + subagentLimitMiddleware 决定）。
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
 * 获取带有动态模型配置的客户端
 * 当请求中指定了 modelKey 或 modelConfig 时使用此方法
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
