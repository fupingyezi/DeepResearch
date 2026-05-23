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

  // === 防 repetition collapse 默认参数 ===
  // 背景：Qwen/DashScope 在 OpenAI 兼容协议下，若不显式给 max_tokens / 重复惩罚，
  // 长 thinking 上下文极易陷入 token 级 loop，吐出 "I will X. I will Y. ..." 这种
  // 模板化退化输出，直到撞 max_tokens 才停。下面是"低风险但显著降级 loop 概率"的默认值。
  // 业务侧若需更大上限/不同采样策略，可以通过 ModelConfig 显式覆盖。
  const topP = config?.topP ?? (provider === 'qwen' ? 0.8 : 0.9);
  const maxTokens = config?.maxTokens ?? 4096;
  const frequencyPenalty = config?.frequencyPenalty ?? 0.3;
  const presencePenalty = config?.presencePenalty ?? 0.1;

  if (process.env.NODE_ENV !== 'production') {
    console.log(
      `[createChatModel] model=${modelName} provider=${provider} streaming=${streaming} ` +
        `temp=${temperature} topP=${topP} maxTokens=${maxTokens} ` +
        `freqPenalty=${frequencyPenalty} presPenalty=${presencePenalty}`,
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
    topP,
    maxTokens,
    frequencyPenalty,
    presencePenalty,
  });
}
