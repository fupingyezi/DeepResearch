import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getMemoryRerankerFactory,
  rerankWithFallback,
  resetMemoryRerankerFactory,
  setMemoryRerankerFactory,
  type MemoryReranker,
} from '../rerank';

/**
 * rerankWithFallback 的降级矩阵：工厂缺失 / 构造失败 / API 失败 / 分数长度不符
 * 一律 warnOnce + null（调用方保持 RRF 序），只有「成功返回等长分数数组」才生效。
 */

describe('rerankWithFallback', () => {
  beforeEach(() => {
    resetMemoryRerankerFactory();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resetMemoryRerankerFactory();
    vi.restoreAllMocks();
  });

  it('工厂未注册 → null，不告警', async () => {
    await expect(rerankWithFallback('q', ['a', 'b'])).resolves.toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('docs ≤ 1 短路返回全 1，不调用工厂（省一次 API 调用）', async () => {
    const factory = vi.fn<() => MemoryReranker | null>(() => null);
    setMemoryRerankerFactory(factory);

    await expect(rerankWithFallback('q', [])).resolves.toEqual([]);
    await expect(rerankWithFallback('q', ['a'])).resolves.toEqual([1]);
    expect(factory).not.toHaveBeenCalled();
  });

  it('工厂返回 null → null（无 Key 场景，检索保持 RRF 序）', async () => {
    setMemoryRerankerFactory(() => null);
    await expect(rerankWithFallback('q', ['a', 'b'])).resolves.toBeNull();
  });

  it('工厂抛错 → warnOnce + null', async () => {
    setMemoryRerankerFactory(() => {
      throw new Error('boom');
    });
    await expect(rerankWithFallback('q', ['a', 'b'])).resolves.toBeNull();
    await expect(rerankWithFallback('q', ['a', 'b'])).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('rerank 成功 → 分数原样透传', async () => {
    const reranker: MemoryReranker = {
      rerank: async (_q, docs) => docs.map((_, i) => i),
    };
    setMemoryRerankerFactory(() => reranker);

    await expect(rerankWithFallback('q', ['a', 'b', 'c'])).resolves.toEqual([0, 1, 2]);
  });

  it('rerank 失败一次 → null；恢复后不因 warnOnce 标记而不再调用', async () => {
    let fail = true;
    setMemoryRerankerFactory(() => ({
      rerank: async () => {
        if (fail) throw new Error('api down');
        return [0.9, 0.1];
      },
    }));

    await expect(rerankWithFallback('q', ['a', 'b'])).resolves.toBeNull();
    fail = false;
    await expect(rerankWithFallback('q', ['a', 'b'])).resolves.toEqual([0.9, 0.1]);
  });

  it('分数长度与 docs 不符 → warnOnce + null（防错位乱序）', async () => {
    setMemoryRerankerFactory(() => ({ rerank: async () => [0.5] }));

    await expect(rerankWithFallback('q', ['a', 'b'])).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('非数组分数 → warnOnce + null', async () => {
    setMemoryRerankerFactory(() => ({
      rerank: async () => undefined as unknown as number[],
    }));

    await expect(rerankWithFallback('q', ['a', 'b'])).resolves.toBeNull();
  });

  it('set(null) 清空工厂', async () => {
    setMemoryRerankerFactory(() => ({ rerank: async () => [1, 0] }));
    expect(getMemoryRerankerFactory()).not.toBeNull();

    setMemoryRerankerFactory(null);
    expect(getMemoryRerankerFactory()).toBeNull();
    await expect(rerankWithFallback('q', ['a', 'b'])).resolves.toBeNull();
  });
});
