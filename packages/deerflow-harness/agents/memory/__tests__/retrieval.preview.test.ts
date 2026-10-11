import { describe, expect, it } from 'vitest';

import { retrieveMemory } from '../retrieval';
import { buildRetrievalDetail } from '../retrieval.preview';
import type { Fact, MemoryData } from '../types';

const QUERY_VEC = [1, 0, 0, 0];

/** 与 QUERY_VEC 余弦恰为 c 的单位向量。 */
function unit(c: number): number[] {
  return [c, Math.sqrt(1 - c * c), 0, 0];
}

function fact(content: string, confidence = 0.9, id = content, embedding?: number[]): Fact {
  return {
    id,
    content,
    category: 'knowledge',
    confidence,
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

/** 打分明细组装：数据全部取自 collectTrace 的管线快照，明细层只做整形——
 *  以下用例锁定的不是明细自身的计算，而是「明细与真实管线同源」这一不变量。 */
describe('buildRetrievalDetail · 打分明细', () => {
  it('bm25 覆盖全量语料：未进 top-50 召回者也有真实分', async () => {
    // 55 条高 tf 条目把 target 挤出 top-50 召回（RECALL_EACH=50），
    // 但明细应显示其真实词面分而非 0——0 会被误读成「词面完全不匹配」
    const strong = Array.from({ length: 55 }, (_, i) => fact('婚礼婚礼婚礼婚礼', 0.9, `s${i}`));
    const data = memory([...strong, fact('这件事与婚礼有关', 0.9, 'target')]);
    const result = await retrieveMemory(data, '婚礼', { topK: 1, collectTrace: true });
    const detail = buildRetrievalDetail(data, result!.trace!).facts.find((d) => d.id === 'target')!;
    expect(detail.bm25).toBeGreaterThan(0);
    expect(detail.picked).toBe(false);
  });

  it('明细同源：inVectorLeg / cosine / rrf 与真实管线一致', async () => {
    const data = memory([
      fact('语义命中', 0.9, 'f_sem', unit(0.65)),
      fact('词面命中 量子计算', 0.9, 'f_lex'),
    ]);
    const result = await retrieveMemory(data, '量子计算', {
      queryEmbedding: QUERY_VEC,
      collectTrace: true,
    });
    const byId = new Map(buildRetrievalDetail(data, result!.trace!).facts.map((d) => [d.id, d]));
    expect(byId.get('f_sem')!.inVectorLeg).toBe(true);
    expect(byId.get('f_sem')!.cosine).toBeCloseTo(0.65, 10);
    expect(byId.get('f_sem')!.bm25).toBe(0);
    expect(byId.get('f_lex')!.inVectorLeg).toBe(false);
    expect(byId.get('f_lex')!.cosine).toBeNull();
    expect(byId.get('f_lex')!.bm25).toBeGreaterThan(0);
  });

  it('明细同源：rerank/final/picked 与真实管线一致', async () => {
    const data = memory([
      fact('用户做量子计算研究', 0.9, 'a'),
      fact('用户研究量子计算的进展', 0.9, 'b'),
      fact('量子计算是用户的研究方向', 0.9, 'c'),
    ]);
    const result = await retrieveMemory(data, '量子计算', {
      rerank: async () => [0.5, 0.9, 0.7],
      collectTrace: true,
    });
    const byId = new Map(buildRetrievalDetail(data, result!.trace!).facts.map((d) => [d.id, d]));
    expect(byId.get('b')!.picked).toBe(true);
    expect(byId.get('b')!.rerankRaw).toBe(0.9); // provider 原始分只进明细，不进计算
    expect(byId.get('b')!.rerank).toBeCloseTo(1 / 61, 10); // 精排第 1 位 → 倒数排名分，与 RRF 同量纲
    expect(byId.get('b')!.final).toBeCloseTo((1 / 61) * 0.95, 10);
    expect(byId.get('b')!.rrf).toBeCloseTo(1 / 62, 10);
    expect(byId.get('b')!.bm25).toBeGreaterThan(0);
    expect(byId.get('a')!.cosine).toBeNull();
    expect(result!.trace!.poolSize).toBe(3);
  });

  it('sections 明细：topOfMind 进池才 picked、history 标记池内最优一段', async () => {
    const data = memory([fact('用户在研究量子计算')], {
      user: {
        workContext: { summary: '', updatedAt: '' },
        personalContext: { summary: '', updatedAt: '' },
        topOfMind: { summary: '最近在准备婚礼', updatedAt: '' },
      },
      history: {
        recentMonths: { summary: '最近在做量子计算相关的研究项目', updatedAt: '' },
        earlierContext: { summary: '早年从事烘焙行业', updatedAt: '' },
        longTermBackground: { summary: '长期关注开源社区', updatedAt: '' },
      },
    });
    const result = await retrieveMemory(data, '量子计算项目进展', { collectTrace: true });
    const byRef = new Map(
      buildRetrievalDetail(data, result!.trace!).sections.map((s) => [s.ref, s]),
    );
    expect(byRef.get('section:user.topOfMind')!.picked).toBe(false); // 词面未命中，不进池
    expect(byRef.get('section:history.recentMonths')!.picked).toBe(true); // 池内最优 history 段
    expect(byRef.get('section:history.earlierContext')!.picked).toBe(false);
    expect(byRef.get('section:history.longTermBackground')!.picked).toBe(false);
    expect(byRef.get('section:history.recentMonths')!.bm25).toBeGreaterThan(0);
  });

  it('topOfMind 命中时 picked 标记与注入侧一致（keepTopOfMind）', async () => {
    const data = memory([fact('用户在研究量子计算')], {
      user: {
        workContext: { summary: '', updatedAt: '' },
        personalContext: { summary: '', updatedAt: '' },
        topOfMind: { summary: '最近在准备婚礼', updatedAt: '' },
      },
    });
    const result = await retrieveMemory(data, '婚礼准备得怎么样了', { collectTrace: true });
    const sections = buildRetrievalDetail(data, result!.trace!).sections;
    expect(sections.find((s) => s.ref === 'section:user.topOfMind')!.picked).toBe(true);
  });
});
