import { afterEach, describe, expect, it } from 'vitest';

import type { Fact, MemoryData } from './types';
import {
  countTokens,
  estimateTokensHeuristic,
  formatMemoryForInjection,
  setTokenCounter,
} from './prompt';

function fact(content: string, confidence = 0.9, id = content): Fact {
  return {
    id,
    content,
    category: 'knowledge',
    confidence,
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'test',
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

afterEach(() => {
  setTokenCounter(null);
});

describe('estimateTokensHeuristic', () => {
  it('纯中文 ≈ 每字 1 token', () => {
    expect(estimateTokensHeuristic('量子计算')).toBe(4);
    expect(estimateTokensHeuristic('用户住在深圳')).toBe(6);
  });

  it('纯 ASCII 按 4 字符/token 向上取整', () => {
    expect(estimateTokensHeuristic('abcdefgh')).toBe(2);
    expect(estimateTokensHeuristic('abcde')).toBe(2); // ceil(5/4)
    expect(estimateTokensHeuristic('abcd')).toBe(1);
  });

  it('中英混排各计各', () => {
    // 3 个汉字 + "abcd" 4 个 ASCII
    expect(estimateTokensHeuristic('量子计算abcd')).toBe(4 + 1);
  });

  it('空串返回 0', () => {
    expect(estimateTokensHeuristic('')).toBe(0);
  });
});

describe('countTokens 回落', () => {
  it('注入抛错的计数器时回落 CJK 感知启发式而非 len/4', () => {
    setTokenCounter(() => {
      throw new Error('boom');
    });
    // 纯中文 6 字：启发式 6；若回落旧 len/4 口径会得到 1
    expect(countTokens('用户住在深圳')).toBe(6);
  });

  it('setTokenCounter(null) 重置回启发式', () => {
    setTokenCounter(() => 12345);
    expect(countTokens('abc')).toBe(12345);
    setTokenCounter(null);
    expect(countTokens('量子')).toBe(2);
  });
});

describe('formatMemoryForInjection token 预算', () => {
  it('facts 逐行累加，超预算即 break（后续更短行也不进）', () => {
    // 行 token（ASCII ceil(len/4)）：header 2 + 首行 10 = 12；预算 13 恰好只容第一条
    const facts = [
      fact('typescript backend', 0.9),
      fact('shenzhen city', 0.8),
      fact('likes cats', 0.7),
    ];
    const text = formatMemoryForInjection(memory(facts), 13);
    expect(text).toContain('typescript backend');
    expect(text).not.toContain('shenzhen city');
    expect(text).not.toContain('likes cats');
  });

  it('缺省按 confidence 降序注入（inject 模式现状）', () => {
    const facts = [fact('low item', 0.5), fact('high item', 0.99), fact('mid item', 0.7)];
    const text = formatMemoryForInjection(memory(facts), 500);
    const high = text.indexOf('high item');
    const mid = text.indexOf('mid item');
    const low = text.indexOf('low item');
    expect(high).toBeLessThan(mid);
    expect(mid).toBeLessThan(low);
  });

  it('preserveFactOrder: true 保持传入序（retrieve 模式的相关度序）', () => {
    // 传入序即检索相关度序：低 confidence 在前也不得被重排
    const facts = [fact('most relevant', 0.5), fact('less relevant', 0.99)];
    const text = formatMemoryForInjection(memory(facts), 500, { preserveFactOrder: true });
    expect(text.indexOf('most relevant')).toBeLessThan(text.indexOf('less relevant'));
  });

  it('facts 为空时不产生 Facts 段', () => {
    const data = memory([], {
      user: {
        workContext: { summary: '后端工程师', updatedAt: '' },
        personalContext: { summary: '', updatedAt: '' },
        topOfMind: { summary: '', updatedAt: '' },
      },
    });
    const text = formatMemoryForInjection(data, 100);
    expect(text).toContain('Work: 后端工程师');
    expect(text).not.toContain('Facts:');
  });

  it('sections 总量超预算时按 charPerToken 兜底硬截断并追加省略号', () => {
    const longSummary = '很长的历史段落'.repeat(200); // 远超预算
    const data = memory([], {
      history: {
        recentMonths: { summary: longSummary, updatedAt: '' },
        earlierContext: { summary: '', updatedAt: '' },
        longTermBackground: { summary: '', updatedAt: '' },
      },
    });
    const text = formatMemoryForInjection(data, 50);
    expect(text.endsWith('\n...')).toBe(true);
    expect(text.length).toBeLessThan(longSummary.length);
  });

  it('null / undefined 返回空串', () => {
    expect(formatMemoryForInjection(null)).toBe('');
    expect(formatMemoryForInjection(undefined)).toBe('');
  });
});
