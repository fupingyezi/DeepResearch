import { ModelConfig, ModelProvider } from '../types';
import { ChatOpenAI } from '@langchain/openai';
import { UsageRecordingHandler } from '../runtime/usage-accounting';

/** 根据 baseUrl / modelName 推断 provider，config.provider 优先级最高 */
export function inferProvider(config: ModelConfig): ModelProvider {
  if (config.provider) return config.provider;

  const url = (config.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? '').toLowerCase();
  const name = (config.modelName ?? '').toLowerCase();

  if (url.includes('dashscope') || url.includes('aliyun') || name.startsWith('qwen')) {
    return 'qwen';
  }
  if (url.includes('deepseek') || name.startsWith('deepseek')) {
    return 'deepseek';
  }
  if (url.includes('bigmodel') || name.startsWith('glm-')) {
    return 'zhipu';
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

  const baseUrl = config?.baseUrl ?? process.env.DEEPSEEK_BASE_URL;
  const apiKey = config?.apiKey ?? process.env.DEEPSEEK_API_KEY;
  const rawModelName = config?.modelName;
  const isInheritPlaceholder = rawModelName === 'inherit';
  if (isInheritPlaceholder) {
    console.warn(
      `[createChatModel] modelName='inherit' detected — inheritedModelConfig was ` +
        `not propagated to subagent (likely lost across LangGraph ToolNode async ` +
        `boundary). Falling back to env default model.`,
    );
  }
  // 兜底模型名用官方名：deepseek-chat 已不在 GET /models 清单内（旧兼容名）。
  const modelName = rawModelName && !isInheritPlaceholder ? rawModelName : 'deepseek-flash';
  const temperature = config?.temperature ?? 0.7;

  const topP = config?.topP ?? (provider === 'qwen' ? 0.8 : 0.9);
  const maxTokens = config?.maxTokens ?? 4096;
  const frequencyPenalty = config?.frequencyPenalty ?? (provider === 'qwen' ? 0 : 0.3);
  const presencePenalty = config?.presencePenalty ?? (provider === 'qwen' ? 0 : 0.1);

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
    // 用量记账（见 runtime/usage-accounting.ts）：这是 lead 与 subagent 唯一的模型工厂，
    // 一处挂载即可覆盖两者以及中间件自身的 LLM 调用。handler 在**调用时**才经 ALS 解析
    // 累加器，产品路径没有记账作用域 → no-op，故 agent 实例跨 run 复用也不会串账。
    callbacks: [new UsageRecordingHandler(modelName)],
  };
  if (frequencyPenalty !== 0) modelOpts.frequencyPenalty = frequencyPenalty;
  if (presencePenalty !== 0) modelOpts.presencePenalty = presencePenalty;

  return new ChatOpenAI(modelOpts);
}
