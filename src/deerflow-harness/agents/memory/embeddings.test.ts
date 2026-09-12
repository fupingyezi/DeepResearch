import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Embeddings } from '@langchain/core/embeddings';

import {
  backfillFactEmbeddings,
  cosineSimilarity,
  EMBEDDING_BATCH_LIMIT,
  embedQuery,
  embedTexts,
  isCompatibleVector,
  resetMemoryEmbeddingsFactory,
  setMemoryEmbeddingsFactory,
} from './embeddings';
import { DEFAULT_MEMORY_CONFIG, setMemoryConfig } from './config';
import { getMemoryStorage, resetMemoryStorage } from './storage';
import type { Fact } from './types';

const DIMS = 4;

/** 行为可注入的假 Embeddings：按调用记录切片边界，支持延迟与失败。 */
class FakeEmbeddings {
  constructor(
    private readonly behavior: (texts: string[], callIndex: number) => Promise<number[][]>,
    readonly calls: string[][] = [],
  ) {}
  async embedDocuments(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return this.behavior(texts, this.calls.length - 1);
  }
  async embedQuery(text: string): Promise<number[]> {
    const [first] = await this.embedDocuments([text]);
    return first;
  }
}

function fakeEmbeddings(
  behavior: (texts: string[], callIndex: number) => Promise<number[][]>,
): FakeEmbeddings {
  return new FakeEmbeddings(behavior);
}

function vec(seed: number): number[] {
  return Array.from({ length: DIMS }, (_, i) => (i === 0 ? seed : seed / 2));
}

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

describe('cosineSimilarity / isCompatibleVector', () => {
  it('同向 = 1，正交 = 0，零向量 = 0', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0); // 长度不一致
  });

  it('isCompatibleVector：长度不匹配 / 非数组 / 含 NaN 均 false', () => {
    expect(isCompatibleVector(vec(1), DIMS)).toBe(true);
    expect(isCompatibleVector([1, 2], DIMS)).toBe(false);
    expect(isCompatibleVector('nope', DIMS)).toBe(false);
    expect(isCompatibleVector([1, 2, 3, NaN], DIMS)).toBe(false);
    expect(isCompatibleVector(null, DIMS)).toBe(false);
  });
});

describe('embedQuery / embedTexts', () => {
  afterEach(() => {
    resetMemoryEmbeddingsFactory();
    vi.restoreAllMocks();
  });

  it('工厂未注册 → 全部返回 null 且不抛', async () => {
    resetMemoryEmbeddingsFactory();
    await expect(embedQuery('量子计算')).resolves.toBeNull();
    const out = await embedTexts(['a', 'b']);
    expect(out).toEqual([null, null]);
  });

  it('工厂返回 null（无 Key 场景）→ 静默降级', async () => {
    setMemoryEmbeddingsFactory(() => null);
    await expect(embedQuery('量子计算')).resolves.toBeNull();
    expect(await embedTexts(['a'])).toEqual([null]);
  });

  it('超过 64 条时按 EMBEDDING_BATCH_LIMIT 切片多次调用', async () => {
    const total = EMBEDDING_BATCH_LIMIT + 10;
    const texts = Array.from({ length: total }, (_, i) => `text-${i}`);
    const fake = fakeEmbeddings(async (batch) => batch.map((t) => vec(t.length)));
    setMemoryEmbeddingsFactory(() => fake as unknown as Embeddings);

    const out = await embedTexts(texts);
    expect(fake.calls.map((c) => c.length)).toEqual([EMBEDDING_BATCH_LIMIT, 10]);
    expect(out).toHaveLength(total);
    expect(out.every((v) => isCompatibleVector(v, DIMS))).toBe(true);
  });

  it('某批失败 → 该批为 null，其余批次采纳（稀疏数组）', async () => {
    const fake = fakeEmbeddings(async (batch, callIndex) => {
      if (callIndex === 1) throw new Error('batch 1 failed');
      return batch.map(() => vec(1));
    });
    setMemoryEmbeddingsFactory(() => fake as unknown as Embeddings);

    const texts = Array.from({ length: EMBEDDING_BATCH_LIMIT + 5 }, (_, i) => `t${i}`);
    const out = await embedTexts(texts);
    expect(out.slice(0, EMBEDDING_BATCH_LIMIT).every((v) => v != null)).toBe(true);
    expect(out.slice(EMBEDDING_BATCH_LIMIT)).toEqual(Array(5).fill(null));
  });

  it('embedQuery 失败 → null 且不抛', async () => {
    const fake = fakeEmbeddings(async () => {
      throw new Error('api down');
    });
    setMemoryEmbeddingsFactory(() => fake as unknown as Embeddings);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(embedQuery('test')).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe('backfillFactEmbeddings', () => {
  let tmpFile: string;

  beforeEach(async () => {
    tmpFile = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'memory-emb-test-')),
      'memory.json',
    );
    setMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, storagePath: tmpFile, embeddingDimensions: DIMS });
    resetMemoryStorage();
  });

  afterEach(async () => {
    resetMemoryEmbeddingsFactory();
    resetMemoryStorage();
    setMemoryConfig({ ...DEFAULT_MEMORY_CONFIG });
    await fs.rm(path.dirname(tmpFile), { recursive: true, force: true }).catch(() => {});
  });

  it('只补缺失项，已有合法向量的 fact 不重嵌', async () => {
    const existing = vec(7);
    const scope = { agentName: null, userId: null };
    await getMemoryStorage().save(
      {
        ...emptyMemory(),
        facts: [fact('已有向量', 'fact_a', existing), fact('没有向量', 'fact_b')],
      },
      scope,
    );

    const fake = fakeEmbeddings(async (batch) => batch.map(() => vec(1)));
    setMemoryEmbeddingsFactory(() => fake as unknown as Embeddings);

    await backfillFactEmbeddings(scope);

    // 只为 fact_b 嵌入
    expect(fake.calls.flat()).toEqual(['没有向量']);
    const reloaded = await getMemoryStorage().reload(scope);
    const a = reloaded.facts.find((f) => f.id === 'fact_a');
    const b = reloaded.facts.find((f) => f.id === 'fact_b');
    expect(a?.embedding).toEqual(existing); // 原向量不动
    expect(b?.embedding).toEqual(vec(1));
  });

  it('维度不匹配的旧向量视为缺失并重嵌', async () => {
    const scope = { agentName: null, userId: null };
    await getMemoryStorage().save(
      { ...emptyMemory(), facts: [fact('旧维度', 'fact_c', [1, 2, 3])] },
      scope,
    );
    const fake = fakeEmbeddings(async (batch) => batch.map(() => vec(2)));
    setMemoryEmbeddingsFactory(() => fake as unknown as Embeddings);

    await backfillFactEmbeddings(scope);
    const reloaded = await getMemoryStorage().reload(scope);
    expect(reloaded.facts[0]?.embedding).toEqual(vec(2));
  });

  it('嵌入期间的并发写入不被覆盖（save 前 reload 合并）', async () => {
    const scope = { agentName: null, userId: null };
    await getMemoryStorage().save({ ...emptyMemory(), facts: [fact('待回填', 'fact_d')] }, scope);

    // 模拟 updater 在嵌入期间写入了新 fact
    const fake = fakeEmbeddings(async (batch) => {
      const storage = getMemoryStorage();
      const latest = await storage.reload(scope);
      if (!latest.facts.some((f) => f.id === 'fact_concurrent')) {
        latest.facts.push(fact('并发新增', 'fact_concurrent'));
        await storage.save(latest, scope);
      }
      return batch.map(() => vec(3));
    });
    setMemoryEmbeddingsFactory(() => fake as unknown as Embeddings);

    await backfillFactEmbeddings(scope);

    const reloaded = await getMemoryStorage().reload(scope);
    const ids = reloaded.facts.map((f) => f.id);
    expect(ids).toContain('fact_d');
    expect(ids).toContain('fact_concurrent'); // 并发写入未丢失
    expect(reloaded.facts.find((f) => f.id === 'fact_d')?.embedding).toEqual(vec(3));
  });

  it('in-flight 去重：并发两次只执行一次回填', async () => {
    const scope = { agentName: null, userId: null };
    await getMemoryStorage().save({ ...emptyMemory(), facts: [fact('x', 'fact_e')] }, scope);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeEmbeddings(async (batch) => {
      await gate; // 挂起第一次调用，让并发 backfill 命中 in-flight 去重
      return batch.map(() => vec(4));
    });
    setMemoryEmbeddingsFactory(() => fake as unknown as Embeddings);

    const p1 = backfillFactEmbeddings(scope);
    const p2 = backfillFactEmbeddings(scope);
    release();
    await Promise.all([p1, p2]);

    expect(fake.calls).toHaveLength(1);
  });

  it('embeddingEnabled=false 时直接跳过', async () => {
    setMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, storagePath: tmpFile, embeddingEnabled: false });
    const fake = fakeEmbeddings(async (batch) => batch.map(() => vec(1)));
    setMemoryEmbeddingsFactory(() => fake as unknown as Embeddings);
    await backfillFactEmbeddings({ agentName: null, userId: null });
    expect(fake.calls).toHaveLength(0);
  });
});

function emptyMemory() {
  return {
    version: '1.0' as const,
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
    facts: [] as Fact[],
  };
}
