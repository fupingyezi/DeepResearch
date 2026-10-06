import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MEMORY_CONFIG, setMemoryConfig } from '../config';
import { resetMemoryEmbeddingsFactory } from '../embeddings';
import { previewMemoryRetrieval } from '../injection.preview';
import { PgMemoryStorage } from '../pg-storage';
import { resetMemoryRerankerFactory, setMemoryRerankerFactory } from '../rerank';
import { getMemoryStorage, resetMemoryStorage, setMemoryStorage } from '../storage';
import type { Fact, MemoryData } from '../types';
import { FakeSql } from './fake-sql';

const DIMS = 4;

/** 检索效果预览端到端：走真实 storage（PgMemoryStorage + 假 SQL），覆盖
 *  previewMemoryRetrieval 的行为（与注入侧同源、rerank 开关、配置开关生效）。 */
describe('previewMemoryRetrieval · 检索效果预览', () => {
  function fact(content: string, id = content, embedding?: number[]): Fact {
    return {
      id,
      content,
      category: 'knowledge',
      confidence: 0.9,
      createdAt: '2026-01-01T00:00:00.000Z',
      source: 'test',
      ...(embedding ? { embedding } : {}),
    };
  }

  function memory(facts: Fact[], overrides?: Partial<MemoryData>): MemoryData {
    return {
      version: '1.0',
      lastUpdated: '2026-01-01T00:00:00.000Z',
      user: {
        workContext: { summary: '', updatedAt: '' },
        personalContext: { summary: '', updatedAt: '' },
        topOfMind: { summary: '', updatedAt: '' },
      },
      history: {
        recentMonths: { summary: '', updatedAt: '' },
        earlierContext: { summary: '', updatedAt: '' },
        longTermBackground: { summary: '', updatedAt: '' },
      },
      facts,
      ...overrides,
    };
  }

  beforeEach(() => {
    setMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, embeddingDimensions: DIMS });
    setMemoryStorage(new PgMemoryStorage(new FakeSql()));
  });

  afterEach(() => {
    resetMemoryEmbeddingsFactory();
    resetMemoryRerankerFactory();
    resetMemoryStorage();
    setMemoryConfig({ ...DEFAULT_MEMORY_CONFIG });
  });

  it('预览接口不传 recentQueries：单 query 行为与注入侧一致', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await getMemoryStorage().save(memory([fact('用户偏好用 pnpm 管理依赖')]), {
      agentName: null,
      userId: null,
    });

    const preview = await previewMemoryRetrieval({ query: '它呢？' });
    expect(preview.injectedText).toBe(''); // 无历史可拼，单 query 无命中
    expect(preview.thresholds).toEqual({ semanticMatch: 0.6 });
    expect(preview.poolSize).toBe(0);
    expect(preview.rerankUsed).toBe(false);
    expect(preview.vectorLeg).toBeNull();
    warn.mockRestore();
  });

  it('rerank 工厂已注册 → 预览 rerankUsed=true，管线产物透出', async () => {
    await getMemoryStorage().save(
      memory([
        fact('用户偏好用 pnpm 管理依赖', 'f_pnpm'),
        fact('用户用 pnpm 管理 monorepo', 'f_mono'),
      ]),
      { agentName: null, userId: null },
    );
    setMemoryRerankerFactory(() => ({ rerank: async (_q, docs) => docs.map(() => 1) }));

    const preview = await previewMemoryRetrieval({ query: 'pnpm 管理依赖' });
    expect(preview.rerankUsed).toBe(true);
    expect(preview.poolSize).toBe(2);
    expect(preview.facts.filter((d) => d.picked).length).toBeGreaterThan(0);
    expect(preview.injectedText).toContain('mode="retrieve"');
  });

  it('config.rerankEnabled=false → 即使工厂已注册也不调用 rerank', async () => {
    const reranker = { rerank: vi.fn(async () => [0.9, 0.1]) };
    setMemoryRerankerFactory(() => reranker);
    setMemoryConfig({
      ...DEFAULT_MEMORY_CONFIG,
      embeddingDimensions: DIMS,
      rerankEnabled: false,
    });
    await getMemoryStorage().save(
      memory([
        fact('用户偏好用 pnpm 管理依赖', 'f_pnpm'),
        fact('用户用 pnpm 管理 monorepo', 'f_mono'),
      ]),
      { agentName: null, userId: null },
    );

    const preview = await previewMemoryRetrieval({ query: 'pnpm 管理依赖' });
    expect(preview.rerankUsed).toBe(false);
    expect(preview.config.rerankEnabled).toBe(false);
    expect(reranker.rerank).not.toHaveBeenCalled();
    expect(preview.injectedText).toContain('mode="retrieve"'); // RRF 序照常注入
  });
});
