import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Embeddings } from '@langchain/core/embeddings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MEMORY_CONFIG, setMemoryConfig } from '../config';
import { resetMemoryEmbeddingsFactory, setMemoryEmbeddingsFactory } from '../embeddings';
import { buildMemoryContext, previewMemoryRetrieval } from '../index';
import { getMemoryStorage, resetMemoryStorage } from '../storage';
import type { Fact, MemoryData } from '../types';

const DIMS = 4;
const QUERY_VEC = [1, 0, 0, 0];

/** 记忆检索端到端：走真实 storage（tmp 文件），覆盖 buildMemoryContext 的
 *  retrieve 分支行为（多轮 query、空 query 回落、阈值配置生效）。 */
describe('buildMemoryContext · retrieve 模式', () => {
  let tmpDir: string;

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

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-inject-test-'));
    setMemoryConfig({
      ...DEFAULT_MEMORY_CONFIG,
      storagePath: path.join(tmpDir, 'memory.json'),
      embeddingDimensions: DIMS,
    });
    resetMemoryStorage();
  });

  afterEach(async () => {
    resetMemoryEmbeddingsFactory();
    resetMemoryStorage();
    setMemoryConfig({ ...DEFAULT_MEMORY_CONFIG });
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('空 query 且无历史 → 回落全量注入（而非整段不注入）', async () => {
    await getMemoryStorage().save(memory([fact('用户偏好用 TypeScript 写后端服务')]), {
      agentName: null,
      userId: null,
    });

    const block = await buildMemoryContext({ mode: 'retrieve', query: '' });
    expect(block).toContain('<memory>'); // 全量注入标签（无 mode 属性）
    expect(block).not.toContain('mode="retrieve"');
    expect(block).toContain('TypeScript');
  });

  it('query 有信号但全部落空 → 仍不注入（避免无关记忆噪声）', async () => {
    await getMemoryStorage().save(memory([fact('用户住在深圳')]), {
      agentName: null,
      userId: null,
    });

    const block = await buildMemoryContext({ mode: 'retrieve', query: '如何制作提拉米苏' });
    expect(block).toBe('');
  });

  it('多轮 query：省略式提问靠 recentQueries 的词面拼接命中', async () => {
    await getMemoryStorage().save(memory([fact('用户偏好用 pnpm 管理依赖')]), {
      agentName: null,
      userId: null,
    });

    // 「它呢？」自身没有任何可命中 token
    expect(await buildMemoryContext({ mode: 'retrieve', query: '它呢？' })).toBe('');
    // 带上历史轮（词面拼接）后命中
    const block = await buildMemoryContext({
      mode: 'retrieve',
      query: '它呢？',
      recentQueries: ['我用什么包管理器？', 'pnpm 有什么优势'],
    });
    expect(block).toContain('mode="retrieve"');
    expect(block).toContain('pnpm');
  });

  it('resume（本轮无文本）时用最近一轮历史做语义 query', async () => {
    await getMemoryStorage().save(memory([fact('用户喜欢喝手冲咖啡', 'fact_coffee', QUERY_VEC)]), {
      agentName: null,
      userId: null,
    });
    setMemoryEmbeddingsFactory(
      () =>
        ({
          embedQuery: async () => QUERY_VEC,
          embedDocuments: async (texts: string[]) => texts.map(() => QUERY_VEC),
        }) as unknown as Embeddings,
    );

    const block = await buildMemoryContext({
      mode: 'retrieve',
      query: '',
      recentQueries: ['帮我推荐点喝的'],
    });
    expect(block).toContain('mode="retrieve"'); // 不是回落的全量注入
    expect(block).toContain('手冲咖啡');
  });

  it('阈值配置生效：调低门槛后原本被挡下的余弦量级参与检索', async () => {
    const unit = (c: number) => [c, Math.sqrt(1 - c * c), 0, 0];
    await getMemoryStorage().save(memory([fact('完全无关的内容', 'fact_x', unit(0.55))]), {
      agentName: null,
      userId: null,
    });
    setMemoryEmbeddingsFactory(
      () =>
        ({
          embedQuery: async () => QUERY_VEC,
          embedDocuments: async (texts: string[]) => texts.map(() => QUERY_VEC),
        }) as unknown as Embeddings,
    );

    expect(await buildMemoryContext({ mode: 'retrieve', query: '随便聊聊' })).toBe('');

    setMemoryConfig({
      ...DEFAULT_MEMORY_CONFIG,
      storagePath: path.join(tmpDir, 'memory.json'),
      embeddingDimensions: DIMS,
      semanticMatchThreshold: 0.5,
    });
    const block = await buildMemoryContext({ mode: 'retrieve', query: '随便聊聊' });
    expect(block).toContain('mode="retrieve"');
    expect(block).toContain('完全无关的内容');
  });

  it('预览接口不传 recentQueries：单 query 行为与注入侧一致', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await getMemoryStorage().save(memory([fact('用户偏好用 pnpm 管理依赖')]), {
      agentName: null,
      userId: null,
    });

    const preview = await previewMemoryRetrieval({ query: '它呢？' });
    expect(preview.injectedText).toBe(''); // 无历史可拼，单 query 无命中
    expect(preview.thresholds).toEqual({ semanticMatch: 0.6, minScore: 0.05 });
    warn.mockRestore();
  });
});
