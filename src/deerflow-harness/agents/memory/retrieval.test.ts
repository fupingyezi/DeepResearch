import { describe, expect, it } from 'vitest';

import type { Fact, MemoryData } from './types';
import { overlapRatio, retrieveMemory, scoreFact, tokenize } from './retrieval';

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

describe('tokenize', () => {
  it('latin 词小写化并过滤停用词与单字符', () => {
    const tokens = tokenize('The Quantum Computing is a Field');
    expect(tokens).toContain('quantum');
    expect(tokens).toContain('computing');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('is');
    expect(tokens).not.toContain('a');
  });

  it('CJK 产出单字与二元组', () => {
    const tokens = tokenize('量子计算');
    expect(tokens).toContain('量');
    expect(tokens).toContain('量子');
    expect(tokens).toContain('子计');
    expect(tokens).toContain('计算');
  });

  it('空串返回空数组', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('overlapRatio / scoreFact', () => {
  it('完全重合时重叠率为 1', () => {
    const query = new Set(tokenize('量子计算'));
    expect(overlapRatio('量子计算', query)).toBe(1);
  });

  it('部分重合时重叠率介于 0 与 1 之间', () => {
    const query = new Set(tokenize('量子计算 进展'));
    const ratio = overlapRatio('量子计算', query);
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(1);
  });

  it('无重合时为 0', () => {
    const query = new Set(tokenize('烘焙面包'));
    expect(overlapRatio('量子计算', query)).toBe(0);
  });

  it('置信度越高得分越高（同文本）', () => {
    const query = new Set(tokenize('量子计算'));
    const high = scoreFact(fact('量子计算', 1.0), query);
    const low = scoreFact(fact('量子计算', 0.5), query);
    expect(high).toBeGreaterThan(low);
  });
});

describe('retrieveMemory', () => {
  const data = memory([
    fact('用户正在研究量子计算在药物研发中的应用'),
    fact('用户偏好用 TypeScript 写后端服务'),
    fact('用户住在深圳'),
  ]);

  it('命中相关 fact，过滤无关 fact', () => {
    const picked = retrieveMemory(data, '量子计算有什么新进展？');
    expect(picked).not.toBeNull();
    const contents = picked!.facts.map((f) => f.content);
    expect(contents.some((c) => c.includes('量子计算'))).toBe(true);
    expect(contents.some((c) => c.includes('TypeScript'))).toBe(false);
  });

  it('相关 fact 排在首位', () => {
    const picked = retrieveMemory(data, '量子计算');
    expect(picked!.facts[0].content).toContain('量子计算');
  });

  it('topK 截断（保留得分最高的 N 条）', () => {
    const many = memory([
      fact('量子计算 A'),
      fact('量子计算 B'),
      fact('量子计算 C'),
      fact('量子计算 D'),
    ]);
    const picked = retrieveMemory(many, '量子计算', { topK: 2 });
    expect(picked!.facts).toHaveLength(2);
  });

  it('空 query 返回 null（不注入）', () => {
    expect(retrieveMemory(data, '')).toBeNull();
    expect(retrieveMemory(data, '   ')).toBeNull();
  });

  it('全部无关时返回 null', () => {
    expect(retrieveMemory(data, '如何制作提拉米苏')).toBeNull();
  });

  it('data 为 null/undefined 时返回 null', () => {
    expect(retrieveMemory(null, '量子计算')).toBeNull();
    expect(retrieveMemory(undefined, '量子计算')).toBeNull();
  });

  it('minScore 可过滤弱相关项', () => {
    const picked = retrieveMemory(data, '量子计算', { minScore: 0.99 });
    expect(picked).toBeNull();
  });

  it('中英混合 query 命中各自语种的事实', () => {
    const mixed = memory([fact('用户常用 LangChain 构建 agent'), fact('用户的导师姓王')]);
    const picked = retrieveMemory(mixed, 'LangChain 怎么用');
    expect(picked!.facts.map((f) => f.content).join()).toContain('LangChain');
  });

  it('history 段只保留最相关的一段', () => {
    const withHistory = memory([], {
      history: {
        recentMonths: { summary: '最近在做量子计算相关的研究项目', updatedAt: '' },
        earlierContext: { summary: '早年从事烘焙行业', updatedAt: '' },
        longTermBackground: { summary: '长期关注开源社区', updatedAt: '' },
      },
    });
    const picked = retrieveMemory(withHistory, '量子计算项目进展');
    expect(picked!.history.recentMonths.summary).toContain('量子计算');
    expect(picked!.history.earlierContext.summary).toBe('');
    expect(picked!.history.longTermBackground.summary).toBe('');
  });

  it('workContext / personalContext 作为身份信息恒保留', () => {
    const withUser = memory([], {
      user: {
        workContext: { summary: '在一家做量化交易的公司任后端工程师', updatedAt: '' },
        personalContext: { summary: '喜欢徒步', updatedAt: '' },
        topOfMind: { summary: '下周要交季度报告', updatedAt: '' },
      },
    });
    const picked = retrieveMemory(withUser, '量化交易系统的架构怎么设计');
    expect(picked!.user.workContext.summary).toContain('量化交易');
    expect(picked!.user.personalContext.summary).toContain('徒步');
  });

  it('返回结构可直接喂 formatMemoryForInjection（version/lastUpdated 保留）', () => {
    const picked = retrieveMemory(data, '量子计算')!;
    expect(picked.version).toBe('1.0');
    expect(picked.lastUpdated).toBe(data.lastUpdated);
    expect(Array.isArray(picked.facts)).toBe(true);
  });
});
