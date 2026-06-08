import { ModelConfig, ModelProvider } from '@/deerflow-harness';

export type ModelPresetName =
  | 'qwen-max'
  | 'qwen-turbo'
  | 'deepseek-v4-flash'
  | 'deepseek-v4-pro'
  | 'openai-4o'
  | 'moonshot-v1';

export interface ModelPreset {
  key: ModelPresetName;
  label: string;
  provider: ModelProvider;
  modelName: string;
  description: string;
  isBeta?: boolean;
}

export const MODEL_PRESETS: Record<ModelPresetName, ModelPreset> = {
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
 * 各 provider 的默认 Base URL。
 *
 * 用户在「模型管理」中只填 API Key，不填 Base URL；提供与官方兼容端点一致的
 * 默认值，保证即使部署环境未设置 *_BASE_URL 环境变量也能正确路由请求。
 * 若设置了对应环境变量，则环境变量优先（便于自建网关 / 代理）。
 */
const PROVIDER_DEFAULT_BASE_URL: Record<ModelProvider, string | undefined> = {
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  deepseek: 'https://api.deepseek.com/v1',
  openai: 'https://api.openai.com/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  unknown: undefined,
};

/**
 * 从 MODEL_PRESETS 构建 ModelConfig
 * 支持 preset key 或完全自定义的 ModelConfig
 */
export function resolveModelConfig(modelKeyOrConfig?: ModelPresetName | ModelConfig): ModelConfig {
  // 默认使用 deepseek-v4-flash
  if (!modelKeyOrConfig) {
    return buildModelConfigFromPreset('deepseek-v4-flash');
  }

  // 如果是字符串，从预设中查找
  if (typeof modelKeyOrConfig === 'string') {
    const preset = MODEL_PRESETS[modelKeyOrConfig as ModelPresetName];
    if (!preset) {
      console.warn(
        `[resolveModelConfig] Unknown preset: ${modelKeyOrConfig}, fallback to deepseek-v4-flash`,
      );
      return buildModelConfigFromPreset('deepseek-v4-flash');
    }
    return buildModelConfigFromPreset(preset.key);
  }

  // 否则当作 ModelConfig 对象返回
  return modelKeyOrConfig;
}

/**
 * 从预设构建 ModelConfig（含 baseUrl 与采样参数，但不强制注入用户 apiKey）。
 *
 * 说明：
 * - baseUrl 取「对应 *_BASE_URL 环境变量 → provider 默认值」。
 * - apiKey 仅作为**副链路（标题/记忆）兜底**从环境变量读取；主聊天链路不依赖它，
 *   而是通过 buildModelConfigForUser 注入当前用户的解密 Key（见 v3/chat route）。
 *   若部署环境未配置这些环境变量，副链路在无 Key 时会被中间件安全降级跳过。
 */
export function buildModelConfigFromPreset(presetKey: ModelPresetName): ModelConfig {
  const preset = MODEL_PRESETS[presetKey];
  if (!preset) {
    console.warn(
      `[buildModelConfigFromPreset] Unknown preset: ${presetKey}, fallback to deepseek-v4-flash`,
    );
    return buildModelConfigFromPreset('deepseek-v4-flash');
  }

  const config: ModelConfig = {
    modelName: preset.modelName,
    provider: preset.provider,
    temperature: 0.7,
    topP: 0.8,
    maxTokens: 8192,
  };

  const defaultBaseUrl = PROVIDER_DEFAULT_BASE_URL[preset.provider];

  // 按 provider 设置 baseUrl（env 优先，缺省走内置默认）与采样惩罚；
  // apiKey 作为副链路兜底从 env 读取（主链路由用户 Key 覆盖）。
  switch (preset.provider) {
    case 'qwen':
      config.apiKey = process.env.OPENAI_QWEN_API_KEY;
      config.baseUrl = process.env.OPENAI_QWEN_BASE_URL ?? defaultBaseUrl;
      config.frequencyPenalty = 0;
      config.presencePenalty = 0;
      break;

    case 'deepseek':
      config.apiKey = process.env.DEEPSEEK_API_KEY;
      config.baseUrl = process.env.DEEPSEEK_BASE_URL ?? defaultBaseUrl;
      config.frequencyPenalty = 0.3;
      config.presencePenalty = 0.1;
      break;

    case 'openai':
      config.apiKey = process.env.OPENAI_API_KEY;
      config.baseUrl = process.env.OPENAI_API_BASE ?? defaultBaseUrl;
      config.frequencyPenalty = 0.3;
      config.presencePenalty = 0.1;
      break;

    case 'moonshot':
      config.apiKey = process.env.MOONSHOT_API_KEY;
      config.baseUrl = process.env.MOONSHOT_BASE_URL ?? defaultBaseUrl;
      config.frequencyPenalty = 0.3;
      config.presencePenalty = 0.1;
      break;

    default:
      // unknown provider - use DeepSeek as fallback
      config.apiKey = process.env.DEEPSEEK_API_KEY;
      config.baseUrl = process.env.DEEPSEEK_BASE_URL ?? PROVIDER_DEFAULT_BASE_URL.deepseek;
  }

  return config;
}

/**
 * 用「当前用户的解密 API Key」构建主聊天链路的 ModelConfig。
 *
 * baseUrl 与采样参数沿用预设默认；apiKey 由调用方（v3/chat route）从用户加密存储中
 * 解密后传入，覆盖任何环境变量默认值，从而实现「不再内置默认 Key、由用户自带 Key」。
 */
export function buildModelConfigForUser(presetKey: ModelPresetName, apiKey: string): ModelConfig {
  const config = buildModelConfigFromPreset(presetKey);
  config.apiKey = apiKey;
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
