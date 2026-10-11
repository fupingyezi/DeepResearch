import { afterEach, describe, expect, it, vi } from 'vitest';

import { createZhipuReranker } from '../zhipu-rerank';

/**
 * 智谱 rerank 适配层契约：fail-fast（非 2xx 抛错）、按 index 对齐（缺失填 0）、
 * docs ≤ 1 短路。静默降级不属于本层职责（在 harness 封装层）。
 */

describe('createZhipuReranker', () => {
  const opts = { apiKey: 'k', model: 'rerank', baseUrl: 'https://example.com/api' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POST {baseUrl}/rerank：Bearer 认证 + {model, query, documents} body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ index: 0, relevance_score: 0.9 }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const reranker = createZhipuReranker(opts);
    await reranker.rerank('q', ['a', 'b']);

    expect(fetchMock).toHaveBeenCalledWith('https://example.com/api/rerank', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer k',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'rerank', query: 'q', documents: ['a', 'b'] }),
    });
  });

  it('分数按 index 对齐，缺失填 0（响应可能只返回子集）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            { index: 2, relevance_score: 0.7 },
            { index: 0, relevance_score: 0.3 },
          ],
        }),
      }),
    );

    const reranker = createZhipuReranker(opts);
    await expect(reranker.rerank('q', ['a', 'b', 'c'])).resolves.toEqual([0.3, 0, 0.7]);
  });

  it('docs ≤ 1 短路全 1，不发请求', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    const reranker = createZhipuReranker(opts);
    await expect(reranker.rerank('q', [])).resolves.toEqual([]);
    await expect(reranker.rerank('q', ['a'])).resolves.toEqual([1]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('非 2xx 抛错（fail-fast；降级由 harness 封装层兜底）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'upstream error',
      }),
    );

    const reranker = createZhipuReranker(opts);
    await expect(reranker.rerank('q', ['a', 'b'])).rejects.toThrow(
      'zhipu rerank 500: upstream error',
    );
  });

  it('结果项缺字段 / index 越界 / 项为 null 安全跳过', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            { index: 5, relevance_score: 0.9 },
            { index: 1 },
            null,
            { relevance_score: 0.8 },
          ],
        }),
      }),
    );

    const reranker = createZhipuReranker(opts);
    await expect(reranker.rerank('q', ['a', 'b'])).resolves.toEqual([0, 0]);
  });
});
