import { ModelConfig, ModelProvider } from '@/deerflow-harness';

export type ModelPresetKey = 'qwen-max' | 'qwen-turbo' | 'deepseek-v4-flash' | 'deepseek-v4-pro' | 'openai-4o' | 'moonshot-v1';

export interface ModelPreset {
  key: ModelPresetKey;
  label: string;
  provider: ModelProvider;
  modelName: string;
  description: string;
  isBeta?: boolean;
}

export const MODEL_PRESETS: Record<ModelPresetKey, ModelPreset> = {
  'qwen-max': {
    key: 'qwen-max',
    label: 'Qwen Max (阿里)',
    provider: 'qwen',
    modelName: 'qwen-max',
    description: '阿里云 Qwen 最强版本，支持长上下文',
  },
  'qwen-turbo': {
    key: 'qwen-turbo',
    label: 'Qwen Turbo (阿里)',
    provider: 'qwen',
    modelName: 'qwen-turbo',
    description: '阿里云 Qwen 速度版本，响应快',
  },
  'deepseek-v4-flash': {
    key: 'deepseek-v4-flash',
    label: 'DeepSeek v4 Flash',
    provider: 'deepseek',
    modelName: 'deepseek-chat',
    description: 'DeepSeek 通用对话模型（deepseek-chat），适合大多数任务',
  },
  'deepseek-v4-pro': {
    key: 'deepseek-v4-pro',
    label: 'DeepSeek v4 Pro',
    provider: 'deepseek',
    modelName: 'deepseek-reasoner',
    description: 'DeepSeek 推理模型（deepseek-reasoner），适合复杂推理',
    isBeta: true,
  },
  'openai-4o': {
    key: 'openai-4o',
    label: 'OpenAI GPT-4o',
    provider: 'openai',
    modelName: 'gpt-4o',
    description: 'OpenAI 最新多模态模型',
  },
  'moonshot-v1': {
    key: 'moonshot-v1',
    label: 'Moonshot v1 (Kimi)',
    provider: 'moonshot',
    modelName: 'moonshot-v1-8k',
    description: '月之暗面 Moonshot，支持超长上下文',
  },
};

/**
 * 从 MODEL_PRESETS 构建 ModelConfig
 * 支持 preset key 或完全自定义的 ModelConfig
 */
export function resolveModelConfig(
  modelKeyOrConfig?: ModelPresetKey | ModelConfig,
): ModelConfig {
  // 默认使用 deepseek-v4-flash
  if (!modelKeyOrConfig) {
    return buildModelConfigFromPreset('deepseek-v4-flash');
  }

  // 如果是字符串，从预设中查找
  if (typeof modelKeyOrConfig === 'string') {
    const preset = MODEL_PRESETS[modelKeyOrConfig as ModelPresetKey];
    if (!preset) {
      console.warn(`[resolveModelConfig] Unknown preset: ${modelKeyOrConfig}, fallback to deepseek-v4-flash`);
      return buildModelConfigFromPreset('deepseek-v4-flash');
    }
    return buildModelConfigFromPreset(preset.key);
  }

  // 否则当作 ModelConfig 对象返回
  return modelKeyOrConfig;
}

/**
 * 从预设构建完整的 ModelConfig（包含 API key 和 base URL）
 */
export function buildModelConfigFromPreset(presetKey: ModelPresetKey): ModelConfig {
  const preset = MODEL_PRESETS[presetKey];
  if (!preset) {
    console.warn(`[buildModelConfigFromPreset] Unknown preset: ${presetKey}, fallback to deepseek-v4-flash`);
    return buildModelConfigFromPreset('deepseek-v4-flash');
  }

  const config: ModelConfig = {
    modelName: preset.modelName,
    provider: preset.provider,
    temperature: 0.7,
    topP: 0.8,
    maxTokens: 4096,
  };

  // 根据 provider 注入对应的 API 密钥和 base URL
  switch (preset.provider) {
    case 'qwen':
      config.apiKey = process.env.OPENAI_QWEN_API_KEY;
      config.baseUrl = process.env.OPENAI_QWEN_BASE_URL;
      config.frequencyPenalty = 0;
      config.presencePenalty = 0;
      break;

    case 'deepseek':
      config.apiKey = process.env.DEEPSEEK_API_KEY;
      config.baseUrl = process.env.DEEPSEEK_BASE_URL;
      config.frequencyPenalty = 0.3;
      config.presencePenalty = 0.1;
      break;

    case 'openai':
      config.apiKey = process.env.OPENAI_API_KEY;
      config.baseUrl = process.env.OPENAI_API_BASE;
      config.frequencyPenalty = 0.3;
      config.presencePenalty = 0.1;
      break;

    case 'moonshot':
      config.apiKey = process.env.MOONSHOT_API_KEY;
      config.baseUrl = process.env.MOONSHOT_BASE_URL;
      config.frequencyPenalty = 0.3;
      config.presencePenalty = 0.1;
      break;

    default:
      // unknown provider - use DeepSeek as fallback
      config.apiKey = process.env.DEEPSEEK_API_KEY;
      config.baseUrl = process.env.DEEPSEEK_BASE_URL;
  }

  return config;
}

/**
 * 获取所有可用的模型预设（用于前端模型选择器）
 */
export function getAvailablePresets(): ModelPreset[] {
  return Object.values(MODEL_PRESETS);
}

/**
 * 根据 provider 过滤模型预设
 */
export function getPresetsByProvider(provider: ModelProvider): ModelPreset[] {
  return Object.values(MODEL_PRESETS).filter((p) => p.provider === provider);
}
