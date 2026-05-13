import { ModelConfig } from '../types';
import { ChatOpenAI } from '@langchain/openai';

export function createChatModel(config: ModelConfig) {
  return new ChatOpenAI({
    model: config?.modelName ?? 'qwen3.6-plus',
    apiKey: config?.apiKey ?? process.env.OPENAI_QWEN_API_KEY,
    configuration: {
      baseURL: config?.baseUrl ?? process.env.OPENAI_QWEN_BASE_URL,
    },
    streaming: config?.streaming ?? true,
    temperature: config?.temperature ?? 0.7,
  });
}
