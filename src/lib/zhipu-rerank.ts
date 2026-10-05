/**
 * 智谱 rerank API 客户端（裸 fetch）。
 *
 * rerank 接口不是 OpenAI Chat 格式（openai SDK 用不上），直接裸 fetch——
 * 与图片 OCR 的 layout_parsing 裸 fetch 先例（src/lib/files/file-parser.ts）同一做法。
 * 本适配层 fail-fast：非 2xx 抛错、分数按 index 对齐（缺失填 0）。
 * 降级在 harness 封装层（memory/rerank.ts）做，这里不吞错。
 *
 * 分数分布高度压缩（不相关也常 0.99+），只有相对排序有意义。
 */

import type { MemoryReranker } from '@/deerflow-harness';

export interface ZhipuRerankerOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export function createZhipuReranker(opts: ZhipuRerankerOptions): MemoryReranker {
  return {
    rerank: async (query, docs) => {
      if (docs.length <= 1) return docs.map(() => 1);

      const response = await fetch(`${opts.baseUrl}/rerank`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: opts.model, query, documents: docs }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`zhipu rerank ${response.status}: ${text.slice(0, 200)}`);
      }

      const data = (await response.json()) as {
        results?: Array<{ index: number; relevance_score: number }>;
      };

      // 按 index 对齐：缺失的候选填 0（响应可能因 top_n 截断返回子集）
      const scores = new Array<number>(docs.length).fill(0);
      for (const r of data.results ?? []) {
        if (
          typeof r?.index === 'number' &&
          r.index >= 0 &&
          r.index < scores.length &&
          typeof r?.relevance_score === 'number'
        ) {
          scores[r.index] = r.relevance_score;
        }
      }
      return scores;
    },
  };
}
