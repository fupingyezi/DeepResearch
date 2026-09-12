import { describe, expect, it } from 'vitest';

import {
  PRICE_TABLE,
  computeCallCost,
  computeRunCost,
  isPeakPeriod,
  parsePriceTable,
  zonedClock,
  type CostBreakdown,
} from './pricing';
import {
  UsageAccumulator,
  emptyTokenUsage,
  type TokenUsage,
  type UsageCall,
} from './usage-accounting';

/** 2026-09-14 是周一，2026-09-19 是周六（北京时间）。测试一律带 +08:00 偏移，避免依赖宿主时区。 */
const usageWith = (over: Partial<TokenUsage> = {}): TokenUsage => ({
  ...emptyTokenUsage(),
  llmCalls: 1,
  ...over,
});

function costOrThrow(usage: TokenUsage, modelName: string, at: Date): CostBreakdown {
  const cost = computeCallCost(usage, modelName, at);
  if (!cost) throw new Error(`expected cost for ${modelName}, got undefined`);
  return cost;
}

describe('isPeakPeriod 高峰时段判定', () => {
  it.each([
    ['2026-09-14T08:59:00+08:00', false, '周一 08:59 空闲'],
    ['2026-09-14T09:00:00+08:00', true, '周一 09:00 高峰（起点含）'],
    ['2026-09-14T11:59:00+08:00', true, '周一 11:59 高峰'],
    ['2026-09-14T12:00:00+08:00', false, '周一 12:00 空闲（终点不含）'],
    ['2026-09-14T13:59:00+08:00', false, '周一 13:59 空闲'],
    ['2026-09-14T14:00:00+08:00', true, '周一 14:00 高峰'],
    ['2026-09-14T17:59:00+08:00', true, '周一 17:59 高峰'],
    ['2026-09-14T18:00:00+08:00', false, '周一 18:00 空闲'],
    ['2026-09-19T10:00:00+08:00', false, '周六 10:00 空闲'],
    ['2026-09-20T10:00:00+08:00', false, '周日 10:00 空闲'],
  ])('%s → %s（%s）', (iso, expected) => {
    expect(isPeakPeriod(new Date(iso))).toBe(expected);
  });

  it('按价格表配置的时区判定，而非宿主本地时区', () => {
    // 同一个瞬间：北京时间周一 09:00 === UTC 周一 01:00
    const instant = new Date('2026-09-14T01:00:00Z');
    expect(isPeakPeriod(instant, PRICE_TABLE)).toBe(true);

    // 只把时区换成 UTC，同一瞬间就不再是高峰 —— 证明判定跟随配置而非宿主 TZ
    const utcTable = {
      ...PRICE_TABLE,
      peakWindow: { ...PRICE_TABLE.peakWindow, timeZone: 'UTC' },
    };
    expect(isPeakPeriod(instant, utcTable)).toBe(false);
  });

  it('zonedClock 换算为北京时间的星期与分钟数', () => {
    const { weekday, minutesOfDay } = zonedClock(
      new Date('2026-09-14T09:30:00+08:00'),
      'Asia/Shanghai',
    );
    expect(weekday).toBe(1); // 周一
    expect(minutesOfDay).toBe(9 * 60 + 30);
  });
});

describe('computeCallCost 单次计价', () => {
  const offPeak = new Date('2026-09-14T03:00:00+08:00');
  const peak = new Date('2026-09-14T10:00:00+08:00');

  it('命中缓存的输入按 cacheHit、其余按 cacheMiss，不重复计费', () => {
    const cost = costOrThrow(
      usageWith({
        inputTokens: 1_000_000,
        cacheReadTokens: 800_000,
        outputTokens: 1_000_000,
      }),
      'deepseek-flash',
      offPeak,
    );

    // flash 空闲价：命中 0.02 / 未命中 1 / 输出 4（元每 1M）
    expect(cost.cacheHit).toBeCloseTo(0.8 * 0.02, 10);
    expect(cost.cacheMiss).toBeCloseTo(0.2 * 1, 10);
    expect(cost.output).toBeCloseTo(4, 10);
    expect(cost.peak).toBe(false);
    expect(cost.total).toBeCloseTo(cost.cacheHit + cost.cacheMiss + cost.output, 10);
  });

  it('高峰时段单价翻倍', () => {
    const input = usageWith({ inputTokens: 1_000_000 });
    expect(costOrThrow(input, 'deepseek-flash', peak).total).toBeCloseTo(
      costOrThrow(input, 'deepseek-flash', offPeak).total * 2,
      10,
    );
  });

  it('reasoning token 计入输出价（不额外计费）', () => {
    const base = costOrThrow(usageWith({ outputTokens: 1_000 }), 'deepseek-v4-pro', offPeak);
    const withReasoning = costOrThrow(
      usageWith({ outputTokens: 1_000, reasoningTokens: 900 }),
      'deepseek-v4-pro',
      offPeak,
    );
    expect(withReasoning.total).toBeCloseTo(base.total, 10);
  });

  it('未知模型返回 undefined（绝不猜价）', () => {
    expect(computeCallCost(usageWith({ inputTokens: 100 }), 'gpt-4o', offPeak)).toBeUndefined();
  });

  it('cacheRead 大于 input 时未命中量不为负', () => {
    const cost = costOrThrow(
      usageWith({ inputTokens: 1_000, cacheReadTokens: 5_000 }),
      'deepseek-flash',
      offPeak,
    );
    expect(cost.cacheMiss).toBe(0);
  });
});

describe('computeRunCost 汇总', () => {
  function accumulate(calls: Array<Partial<UsageCall>>): UsageAccumulator {
    const acc = new UsageAccumulator();
    calls.forEach((call, i) => {
      acc.record(`run-${i}`, {
        modelName: call.modelName ?? 'deepseek-flash',
        usage: call.usage ?? emptyTokenUsage(),
        at: call.at ?? 0,
      });
    });
    return acc;
  }

  it('跨时段逐次计价，并给出「全部高峰」上界', () => {
    const offPeakMs = new Date('2026-09-14T03:00:00+08:00').getTime();
    const peakMs = new Date('2026-09-14T10:00:00+08:00').getTime();
    const tokens = { inputTokens: 1_000_000, llmCalls: 1 };

    const acc = accumulate([
      { usage: { ...emptyTokenUsage(), ...tokens }, at: offPeakMs },
      { usage: { ...emptyTokenUsage(), ...tokens }, at: peakMs },
    ]);
    const cost = computeRunCost(acc.snapshot());

    expect(cost.offPeakCalls).toBe(1);
    expect(cost.peakCalls).toBe(1);

    // 每次调用都是 1M 未命中输入，flash 空闲价 1 元/1M。两次调用若都在空闲时段，
    // 单次基线为 1 元；实际一次空闲 + 一次高峰 = 1 + 2 = 3 元；全高峰上界 = 2 + 2 = 4 元。
    const oneOffPeakCall = costOrThrow(
      usageWith(tokens),
      'deepseek-flash',
      new Date(offPeakMs),
    ).total;
    expect(oneOffPeakCall).toBeCloseTo(1, 10);
    expect(cost.total).toBeCloseTo(oneOffPeakCall * 3, 10);
    expect(cost.ifAllPeak).toBeCloseTo(oneOffPeakCall * 4, 10);
  });

  it('未知模型的费用不计入 total，但列进 unknownModels', () => {
    const acc = accumulate([
      {
        modelName: 'deepseek-flash',
        usage: { ...emptyTokenUsage(), inputTokens: 1_000_000, llmCalls: 1 },
        at: 0,
      },
      {
        modelName: 'some-new-model',
        usage: { ...emptyTokenUsage(), inputTokens: 1_000_000, llmCalls: 1 },
        at: 0,
      },
    ]);
    const cost = computeRunCost(acc.snapshot());

    expect(cost.unknownModels).toEqual(['some-new-model']);
    expect(Object.keys(cost.byModel)).toEqual(['deepseek-flash']);
    expect(cost.total).toBeCloseTo(cost.byModel['deepseek-flash'], 10);
  });

  it('暴露记账缺口：拿不到用量 / 只有粗粒度用量的调用数', () => {
    const acc = new UsageAccumulator();
    acc.recordMissing('run-a');
    acc.recordCoarse('run-b', {
      modelName: 'deepseek-flash',
      usage: { ...emptyTokenUsage(), inputTokens: 10, llmCalls: 1 },
      at: 0,
    });

    const cost = computeRunCost(acc.snapshot());
    expect(cost.callsMissingUsage).toBe(1);
    expect(cost.callsCoarseUsage).toBe(1);
  });

  it('携带价格表的来源信息，便于判断数字是否过期', () => {
    const cost = computeRunCost(new UsageAccumulator().snapshot());
    expect(cost.currency).toBe('CNY');
    expect(cost.priceAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(cost.priceSource).toContain('api-docs.deepseek.com');
  });
});

describe('parsePriceTable 价格表校验', () => {
  it('内置价格表包含两档模型（防止 JSON 里漏项）', () => {
    expect(Object.keys(PRICE_TABLE.models).sort()).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
  });

  it('缺字段直接抛错，不静默退回默认价', () => {
    expect(() =>
      parsePriceTable({
        asOf: '2026-09-12',
        source: 'x',
        currency: 'CNY',
        unit: '元 / 1M tokens',
        peakWindow: { timeZone: 'Asia/Shanghai', weekdays: [1], ranges: [['09:00', '12:00']] },
        models: {
          m: {
            offPeak: { cacheHit: 1, cacheMiss: 2 },
            peak: { cacheHit: 1, cacheMiss: 2, output: 3 },
          },
        },
      }),
    ).toThrow(/output/);
  });

  it('空 models 抛错', () => {
    expect(() =>
      parsePriceTable({
        asOf: '2026-09-12',
        source: 'x',
        currency: 'CNY',
        unit: '元 / 1M tokens',
        peakWindow: { timeZone: 'Asia/Shanghai', weekdays: [1], ranges: [['09:00', '12:00']] },
        models: {},
      }),
    ).toThrow(/models/);
  });
});
