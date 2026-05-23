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

  // === 采样默认参数 ===
  // 目标：在不触发 token 级 repetition collapse 的同时，保证 Qwen/DashScope
  // 在 OpenAI 兼容协议下仍走真正的流式输出。
  //
  // 注意：DashScope 的 OpenAI 兼容层对 frequency_penalty / presence_penalty 的
  // 兼容比较脆弱——同时设置非零值 + streaming=true 时，部分版本会把整段回复
  // 当作单个 chunk 一次性返回（表现：服务端 contentLen 一次到位、客户端收不到
  // stream_chunk）。Qwen 自己防重复主要靠 `repetition_penalty`，而该参数在
  // OpenAI 兼容协议里没有标准映射，所以这里在 qwen provider 下默认不发送
  // freq/presence penalty，改用更收敛的 topP + maxTokens + 中间件级别的
  // 重复检测（QwenToolCallRecovery / LoopDetection / OutputRepetitionGuard）
  // 来兜底。其他 provider 仍按通用最佳实践给中等惩罚值。
  const topP = config?.topP ?? (provider === 'qwen' ? 0.8 : 0.9);
  const maxTokens = config?.maxTokens ?? 4096;
  const frequencyPenalty =
    config?.frequencyPenalty ?? (provider === 'qwen' ? 0 : 0.3);
  const presencePenalty =
    config?.presencePenalty ?? (provider === 'qwen' ? 0 : 0.1);

  if (process.env.NODE_ENV !== 'production') {
    console.log(
      `[createChatModel] model=${modelName} provider=${provider} streaming=${streaming} ` +
        `temp=${temperature} topP=${topP} maxTokens=${maxTokens} ` +
        `freqPenalty=${frequencyPenalty} presPenalty=${presencePenalty}`,
    );
  }

  // qwen / deepseek / moonshot 等 OpenAI 兼容协议都直接用 ChatOpenAI；
  // provider 差异通过中间件（如 qwenToolCallRecoveryMiddleware）兜底。
  // 仅在 penalty 非 0 时才下发，避免 DashScope 兼容层因不识别参数回退到非流式。
  const modelOpts: ConstructorParameters<typeof ChatOpenAI>[0] = {
    model: modelName,
    apiKey,
    configuration: { baseURL: baseUrl },
    streaming,
    temperature,
    topP,
    maxTokens,
  };
  if (frequencyPenalty !== 0) modelOpts.frequencyPenalty = frequencyPenalty;
  if (presencePenalty !== 0) modelOpts.presencePenalty = presencePenalty;

  return new ChatOpenAI(modelOpts);
}
