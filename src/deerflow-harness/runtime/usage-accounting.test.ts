import { describe, expect, it } from 'vitest';

import type { LLMResult } from '@langchain/core/outputs';

import {
  UsageAccumulator,
  emptyTokenUsage,
  mergeRunUsage,
  tokenUsageFromLLMResult,
  tokenUsageFromUsageMetadata,
  withUsageAccounting,
  type UsageCall,
} from './usage-accounting';

/** 造一个最小的 LLMResult；message 就是 chat generation 上的 AIMessage。 */
function llmResult(message: unknown, llmOutput?: unknown): LLMResult {
  return { generations: [[{ message }]], llmOutput } as unknown as LLMResult;
}

const call = (inputTokens: number, at: number, modelName = 'deepseek-flash'): UsageCall => ({
  modelName,
  usage: { ...emptyTokenUsage(), inputTokens, llmCalls: 1 },
  at,
});

describe('tokenUsageFromUsageMetadata', () => {
  it('提取 input/output/cache_read/reasoning', () => {
    expect(
      tokenUsageFromUsageMetadata({
        input_tokens: 1000,
        output_tokens: 200,
        input_token_details: { cache_read: 800 },
        output_token_details: { reasoning: 150 },
      }),
    ).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 800,
      reasoningTokens: 150,
      llmCalls: 1,
    });
  });

  it('拿不到用量（缺失或全 0）返回 undefined', () => {
    expect(tokenUsageFromUsageMetadata(undefined)).toBeUndefined();
    expect(tokenUsageFromUsageMetadata({ input_tokens: 0, output_tokens: 0 })).toBeUndefined();
  });

  it('cache_read 超过 input 时夹到 input（防止上游按 chunk 重复累加）', () => {
    const usage = tokenUsageFromUsageMetadata({
      input_tokens: 100,
      output_tokens: 10,
      input_token_details: { cache_read: 999 },
    });
    expect(usage?.cacheReadTokens).toBe(100);
  });
});

describe('tokenUsageFromLLMResult', () => {
  it('优先用 message.usage_metadata（带 cache/reasoning 明细）', () => {
    const { usage, coarse } = tokenUsageFromLLMResult(
      llmResult({
        usage_metadata: {
          input_tokens: 500,
          output_tokens: 100,
          input_token_details: { cache_read: 400 },
        },
        response_metadata: { usage: { prompt_cache_hit_tokens: 999 } },
      }),
    );

    expect(coarse).toBeUndefined();
    expect(usage?.inputTokens).toBe(500);
    expect(usage?.cacheReadTokens).toBe(400);
  });

  it('标准字段缺失时用 DeepSeek 原生 prompt_cache_hit_tokens 兜底（差 50 倍价格）', () => {
    const { usage } = tokenUsageFromLLMResult(
      llmResult({
        usage_metadata: { input_tokens: 500, output_tokens: 100 },
        response_metadata: { usage: { prompt_cache_hit_tokens: 480 } },
      }),
    );

    expect(usage?.cacheReadTokens).toBe(480);
  });

  it('标准字段缺失时也可用 prompt_tokens_details.cached_tokens 兜底', () => {
    const { usage } = tokenUsageFromLLMResult(
      llmResult({
        usage_metadata: { input_tokens: 500, output_tokens: 100 },
        response_metadata: { usage: { prompt_tokens_details: { cached_tokens: 300 } } },
      }),
    );

    expect(usage?.cacheReadTokens).toBe(300);
  });

  it('无 usage_metadata 时退回粗粒度 tokenUsage，并单独标记（缓存命中无法体现）', () => {
    const { usage, coarse } = tokenUsageFromLLMResult(
      llmResult({}, { tokenUsage: { promptTokens: 300, completionTokens: 50 } }),
    );

    expect(usage).toBeUndefined();
    expect(coarse?.inputTokens).toBe(300);
    expect(coarse?.cacheReadTokens).toBe(0);
    expect(coarse?.llmCalls).toBe(1);
  });

  it('两者都没有时返回空对象（由调用方记为 missing）', () => {
    const result = tokenUsageFromLLMResult(llmResult({}));
    expect(result.usage).toBeUndefined();
    expect(result.coarse).toBeUndefined();
  });
});

describe('UsageAccumulator', () => {
  it('同一 runId 重复上报只计一次（防御网关重复下发导致费用翻倍）', () => {
    const acc = new UsageAccumulator();
    const record = call(1_000_000, Date.now());
    acc.record('same-run', record);
    acc.record('same-run', record);

    expect(acc.snapshot().total.inputTokens).toBe(1_000_000);
    expect(acc.snapshot().total.llmCalls).toBe(1);
  });

  it('分别记录缺用量与粗粒度用量，便于暴露记账缺口', () => {
    const acc = new UsageAccumulator();
    acc.recordMissing('run-a');
    acc.recordCoarse('run-b', call(10, Date.now()));
    acc.record('run-c', call(20, Date.now()));

    const usage = acc.snapshot();
    expect(usage.callsMissingUsage).toBe(1);
    expect(usage.callsCoarseUsage).toBe(1);
    expect(usage.total.llmCalls).toBe(2);
    expect(usage.byModel['deepseek-flash'].inputTokens).toBe(30);
  });
});

describe('mergeRunUsage', () => {
  it('合并多段用量，并保留逐次调用记录（计价按每次调用自己的时刻）', () => {
    const a = new UsageAccumulator();
    a.record('a1', call(100, 1000));
    const b = new UsageAccumulator();
    b.record('b1', call(200, 2000));
    b.recordMissing('b2');

    const merged = mergeRunUsage([a.snapshot(), b.snapshot(), undefined]);

    expect(merged.total.inputTokens).toBe(300);
    expect(merged.calls.map((c) => c.at)).toEqual([1000, 2000]);
    expect(merged.callsMissingUsage).toBe(1);
  });
});

describe('withUsageAccounting', () => {
  it('作用域内的用量随 Promise 一起返回', async () => {
    const { result, usage } = await withUsageAccounting(async () => {
      const acc = new UsageAccumulator();
      acc.record('r1', call(42, 1));
      return 'done';
    });

    expect(result).toBe('done');
    // 作用域内没有经模型工厂的调用，所以这里应是空的 —— 返回的是**作用域**的用量，
    // 不是外部手动创建的累加器。
    expect(usage.total.llmCalls).toBe(0);
  });
});
