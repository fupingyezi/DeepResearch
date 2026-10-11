import { tool } from 'langchain';
import { TavilySearchAPIRetriever } from '@langchain/community/retrievers/tavily_search_api';

import z from 'zod';

/**
 * Tavily API Key 注入面：宿主部署配置（TAVILY_API_KEY env），harness 不自读 env。
 * 未注册时 searchWebTool 以 apiKey: undefined 调用（Tavily 无 Key 必失败，
 * 错误透传给模型，由 ToolErrorHandling 兜底）。
 * dev 下挂 globalThis：理由同 memory/storage.ts（Next 按路由分包编译，模块级
 * 变量会分裂成多份导致注入静默失效）。
 */
let _apiKey: string | null | undefined = undefined;

const globalForTavilyKey =
  process.env.NODE_ENV === 'production'
    ? null
    : (globalThis as unknown as { __tavilyApiKey?: string | null | undefined });

export function setTavilyApiKey(key: string | null | undefined): void {
  if (globalForTavilyKey) globalForTavilyKey.__tavilyApiKey = key;
  else _apiKey = key;
}

function getTavilyApiKey(): string | undefined {
  return globalForTavilyKey?.__tavilyApiKey ?? _apiKey ?? undefined;
}

export const searchWebTool = tool(
  async (input) => {
    const question = (input?.question ?? '').trim();
    if (!question) {
      // 显式拒绝空 query，避免下游缓存/默认值返回不可控结果，并让 AI 立刻感知。
      return [
        'ERROR: search_web_tool 收到了空的 question 参数。',
        '请在 arguments 中提供非空 `question` 字符串后重试。',
      ].join('\n');
    }

    const tavy = new TavilySearchAPIRetriever({
      apiKey: getTavilyApiKey(),
    });
    const response = await tavy.invoke(question);
    if (!Array.isArray(response) || response.length === 0) {
      return `没有找到与 "${question}" 相关的搜索结果。`;
    }
    const relatedWebInfo = response
      .map((doc, index) => {
        return `结果 ${index + 1}:
        标题: ${doc.metadata.title}
        来源: ${doc.metadata.source}    
        内容: ${doc.pageContent}
        相关性评分: ${doc.metadata.score}
        ---`;
      })
      .join('\n');
    return relatedWebInfo;
  },
  {
    name: 'search_web_tool',
    description: '当用户提到搜索相关信息的时候调用',
    schema: z.object({
      question: z.string().min(1, 'question 不能为空'),
    }),
  },
);
