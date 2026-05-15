import { ModelConfig, ModelProvider } from '../types';
import { ChatOpenAI } from '@langchain/openai';

/** 根据 baseUrl / modelName 推断 provider，config.provider 优先级最高 */
export function inferProvider(config: ModelConfig): ModelProvider {
  if (config.provider) return config.provider;

  const url = (config.baseUrl ?? process.env.OPENAI_QWEN_BASE_URL ?? '').toLowerCase();
  const name = (config.modelName ?? '').toLowerCase();

  if (url.includes('dashscope') || url.includes('aliyun') || name.startsWith('qwen')) {
    return 'qwen';
  }
  if (url.includes('deepseek') || name.startsWith('deepseek')) {
    return 'deepseek';
  }
  if (url.includes('moonshot') || name.startsWith('moonshot')) {
    return 'moonshot';
  }
  if (
    url.includes('openai.com') ||
    name.startsWith('gpt-') ||
    name.startsWith('o1') ||
    name.startsWith('o3')
  ) {
    return 'openai';
  }
  return 'unknown';
}

function defaultStreamingFor(_provider: ModelProvider): boolean {
  return true;
}

export function createChatModel(config: ModelConfig) {
  const provider = inferProvider(config);
  const streaming = config.streaming ?? defaultStreamingFor(provider);

  const baseUrl = config?.baseUrl ?? process.env.OPENAI_QWEN_BASE_URL;
  const apiKey = config?.apiKey ?? process.env.OPENAI_QWEN_API_KEY;
  const modelName = config?.modelName ?? 'qwen3.6-plus';
  const temperature = config?.temperature ?? 0.7;

  if (process.env.NODE_ENV !== 'production') {
    console.log(
      `[createChatModel] model=${modelName} provider=${provider} streaming=${streaming}`,
    );
  }

  // qwen / deepseek / moonshot 等 OpenAI 兼容协议都直接用 ChatOpenAI；
  // provider 差异通过中间件（如 qwenToolCallRecoveryMiddleware）兜底。
  return new ChatOpenAI({
    model: modelName,
    apiKey,
    configuration: { baseURL: baseUrl },
    streaming,
    temperature,
  });
}
