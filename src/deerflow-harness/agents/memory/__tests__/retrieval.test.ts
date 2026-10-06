import { describe, expect, it, vi } from 'vitest';

import type { VectorSearchResult } from '../storage';
import type { Fact, MemoryData } from '../types';
import {
  bm25Score,
  buildBm25Stats,
  lexicalRecall,
  resetMemoryRetrievalDegrades,
  retrieveMemory,
  rrfFuse,
  tokenize,
  vectorRecallJs,
} from '../retrieval';
import { getMemoryDegradeStats, resetMemoryDegradeStats } from '../stats';

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

  it('CJK 范围与 token 计数器一致（Extension A 字符也产出单字）', () => {
    // U+3400（Extension A）：预算按 1 token 计，词面匹配必须能命中同一字符
    const tokens = tokenize('㐀');
    expect(tokens).toEqual(['㐀']);
  });

  it('空串返回空数组', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('buildBm25Stats / bm25Score', () => {
  it('无重合为 0', () => {
    const stats = buildBm25Stats([tokenize('烘焙面包'), tokenize('住在深圳')]);
    expect(bm25Score(tokenize('烘焙面包'), new Set(['量子']), stats)).toBe(0);
  });

  it('稀有词 idf 高于语料高频词：同文档同 tf 下稀有词得分更高', () => {
    const docs = [tokenize('量子计算'), tokenize('量子力学'), tokenize('住在深圳')];
    const stats = buildBm25Stats(docs);
    const doc = tokenize('量子计算');
    // 「计算」只出现在 1/3 文档，「量子」出现在 2/3
    const rare = bm25Score(doc, new Set(['计算']), stats);
    const common = bm25Score(doc, new Set(['量子']), stats);
    expect(rare).toBeGreaterThan(common);
  });

  it('tf 饱和：term 出现两次得分高于一次但不足两倍', () => {
    const docs = [tokenize('量子量子'), tokenize('量子'), tokenize('无关文档内容')];
    const stats = buildBm25Stats(docs);
    const once = bm25Score(tokenize('量子'), new Set(['量子']), stats);
    const twice = bm25Score(tokenize('量子量子'), new Set(['量子']), stats);
    expect(twice).toBeGreaterThan(once);
    expect(twice).toBeLessThan(2 * once);
  });

  it('文档长度归一化：同 tf 下更短的文档得分更高', () => {
    const docs = [tokenize('量子'), tokenize('量子加上一大堆无关的内容文字'), tokenize('无关文档')];
    const stats = buildBm25Stats(docs);
    const shortDoc = bm25Score(tokenize('量子'), new Set(['量子']), stats);
    const longDoc = bm25Score(tokenize('量子加上一大堆无关的内容文字'), new Set(['量子']), stats);
    expect(shortDoc).toBeGreaterThan(longDoc);
  });

  it('空 query / 空文档 / 空语料 → 0', () => {
    const stats = buildBm25Stats([tokenize('量子')]);
    expect(bm25Score(tokenize('量子'), new Set(), stats)).toBe(0);
    expect(bm25Score([], new Set(['量子']), stats)).toBe(0);
    expect(bm25Score([], new Set(['量子']), buildBm25Stats([]))).toBe(0);
  });
});

describe('lexicalRecall', () => {
  const data = memory(
    [
      fact('烘焙量子计算', 0.9, 'f_rare'), // 命中稀有词「计算」+ 高频词「量子」
      fact('量子物理', 0.9, 'f_common'),
      fact('住在深圳', 0.9, 'f_none'),
    ],
    {
      user: {
        workContext: { summary: '', updatedAt: '' },
        personalContext: { summary: '', updatedAt: '' },
        topOfMind: { summary: '量子', updatedAt: '' }, // 短文档，同 tf 下归一化加分
      },
    },
  );

  it('BM25 打分：稀有词权重最高、短文档加分、无关者 0 分、section 参与召回', () => {
    const hits = lexicalRecall(data, new Set(tokenize('量子 计算')), 10);
    expect(hits.map((h) => h.ref)).toEqual([
      'fact:f_rare',
      'section:user.topOfMind',
      'fact:f_common',
    ]);
    expect(hits.every((h) => h.bm25 > 0)).toBe(true);
  });

  it('limit 截断为 top-N', () => {
    const hits = lexicalRecall(data, new Set(tokenize('量子 计算')), 2);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.ref)).toEqual(['fact:f_rare', 'section:user.topOfMind']);
  });

  it('无命中返回空数组', () => {
    expect(lexicalRecall(data, new Set(tokenize('提拉米苏')), 10)).toEqual([]);
  });
});

describe('rrfFuse', () => {
  it('两路排名融合：双路都命中的排最前，rrf 降序', () => {
    const fused = rrfFuse(['a', 'b'], ['b', 'c']);
    expect(fused.map((e) => e.ref)).toEqual(['b', 'a', 'c']);
    expect(fused[0].rrf).toBeCloseTo(1 / 61 + 1 / 62, 10);
    expect(fused[1].rrf).toBeCloseTo(1 / 61, 10);
    expect(fused[2].rrf).toBeCloseTo(1 / 62, 10);
  });

  it('平分时路 A 条目在前（Map 插入序 + 稳定排序，tie 稳定）', () => {
    // a 与 b 各得 1/61 + 1/62：分数相同，路 A 先入 Map 者在前
    const fused = rrfFuse(['a', 'b'], ['b', 'a']);
    expect(fused.map((e) => e.ref)).toEqual(['a', 'b']);
    expect(fused[0].rrf).toBeCloseTo(fused[1].rrf, 10);
  });

  it('poolSize 截断', () => {
    const fused = rrfFuse(['a', 'b', 'c', 'd'], [], 60, 2);
    expect(fused.map((e) => e.ref)).toEqual(['a', 'b']);
  });

  it('k 可配（默认 60）', () => {
    const [entry] = rrfFuse(['a'], [], 10);
    expect(entry.rrf).toBeCloseTo(1 / 11, 10);
  });
});

describe('vectorRecallJs', () => {
  it('余弦降序返回并受 limit 截断', () => {
    const data = memory([
      fact('a', 0.9, 'near', [1, 0, 0, 0]),
      fact('b', 0.9, 'mid', [0, 1, 0, 0]),
      fact('c', 0.9, 'far', [-1, 0, 0, 0]),
    ]);
    const hits = vectorRecallJs(data, QUERY_VEC, 2);
    expect(hits.map((h) => h.refId)).toEqual(['near', 'mid']);
    expect(hits[0].similarity).toBeCloseTo(1, 10);
  });

  it('维度不符的向量与空 summary 的 section 被跳过', () => {
    const data = memory([fact('a', 0.9, 'f3', [1, 0, 0]), fact('b', 0.9, 'f4', [1, 0, 0, 0])], {
      user: {
        workContext: { summary: '', updatedAt: '' },
        personalContext: { summary: '', updatedAt: '' },
        topOfMind: { summary: '', updatedAt: '', embedding: [1, 0, 0, 0] },
      },
    });
    const hits = vectorRecallJs(data, QUERY_VEC, 10);
    expect(hits.map((h) => h.refId)).toEqual(['f4']);
  });
});

describe('retrieveMemory 词面召回', () => {
  const data = memory([
    fact('用户正在研究量子计算在药物研发中的应用'),
    fact('用户偏好用 TypeScript 写后端服务'),
    fact('用户住在深圳'),
  ]);

  it('命中相关 fact，过滤无关 fact', async () => {
    const result = await retrieveMemory(data, '量子计算有什么新进展？');
    expect(result).not.toBeNull();
    const contents = result!.picked.facts.map((f) => f.content);
    expect(contents.some((c) => c.includes('量子计算'))).toBe(true);
    expect(contents.some((c) => c.includes('TypeScript'))).toBe(false);
  });

  it('相关 fact 排在首位', async () => {
    const result = await retrieveMemory(data, '量子计算');
    expect(result!.picked.facts[0].content).toContain('量子计算');
  });

  it('topK 截断（保留得分最高的 N 条）', async () => {
    const many = memory([
      fact('量子计算 A'),
      fact('量子计算 B'),
      fact('量子计算 C'),
      fact('量子计算 D'),
    ]);
    const result = await retrieveMemory(many, '量子计算', { topK: 2 });
    expect(result!.picked.facts).toHaveLength(2);
  });

  it('空 query 返回 null（不注入）', async () => {
    expect(await retrieveMemory(data, '')).toBeNull();
    expect(await retrieveMemory(data, '   ')).toBeNull();
  });

  it('全部无关（双路全空）时返回 null', async () => {
    expect(await retrieveMemory(data, '如何制作提拉米苏')).toBeNull();
  });

  it('data 为 null/undefined 时返回 null', async () => {
    expect(await retrieveMemory(null, '量子计算')).toBeNull();
    expect(await retrieveMemory(undefined, '量子计算')).toBeNull();
  });

  it('中英混合 query 命中各自语种的事实', async () => {
    const mixed = memory([fact('用户常用 LangChain 构建 agent'), fact('用户的导师姓王')]);
    const result = await retrieveMemory(mixed, 'LangChain 怎么用');
    expect(result!.picked.facts.map((f) => f.content).join()).toContain('LangChain');
  });

  it('history 段只保留池内秩最优的一段', async () => {
    const withHistory = memory([], {
      history: {
        recentMonths: { summary: '最近在做量子计算相关的研究项目', updatedAt: '' },
        earlierContext: { summary: '早年从事烘焙行业', updatedAt: '' },
        longTermBackground: { summary: '长期关注开源社区', updatedAt: '' },
      },
    });
    const result = await retrieveMemory(withHistory, '量子计算项目进展');
    expect(result!.picked.history.recentMonths.summary).toContain('量子计算');
    expect(result!.picked.history.earlierContext.summary).toBe('');
    expect(result!.picked.history.longTermBackground.summary).toBe('');
  });

  it('workContext / personalContext 作为身份信息恒保留（检索成功时）', async () => {
    const withUser = memory([fact('用户在研究量子计算')], {
      user: {
        workContext: { summary: '在一家做量化交易的公司任后端工程师', updatedAt: '' },
        personalContext: { summary: '喜欢徒步', updatedAt: '' },
        topOfMind: { summary: '下周要交季度报告', updatedAt: '' },
      },
    });
    const result = await retrieveMemory(withUser, '量子计算');
    expect(result!.picked.user.workContext.summary).toContain('量化交易');
    expect(result!.picked.user.personalContext.summary).toContain('徒步');
  });

  it('topOfMind 进池才保留（词面命中 → 留；未命中 → 丢）', async () => {
    const data2 = memory([fact('用户在研究量子计算')], {
      user: {
        workContext: { summary: '', updatedAt: '' },
        personalContext: { summary: '', updatedAt: '' },
        topOfMind: { summary: '最近在准备婚礼', updatedAt: '' },
      },
    });
    const miss = await retrieveMemory(data2, '量子计算');
    expect(miss!.picked.user.topOfMind.summary).toBe('');

    const hit = await retrieveMemory(data2, '婚礼准备得怎么样了');
    expect(hit!.picked.user.topOfMind.summary).toContain('婚礼');
  });

  it('双路全空 → null，即使存在身份信息（身份信息随检索成功注入）', async () => {
    const onlyUser = memory([], {
      user: {
        workContext: { summary: '在一家做量化交易的公司任后端工程师', updatedAt: '' },
        personalContext: { summary: '喜欢徒步', updatedAt: '' },
        topOfMind: { summary: '下周要交季度报告', updatedAt: '' },
      },
    });
    expect(await retrieveMemory(onlyUser, '如何制作提拉米苏')).toBeNull();
  });

  it('返回结构可直接喂 formatMemoryForInjection（version/lastUpdated 保留）', async () => {
    const result = await retrieveMemory(data, '量子计算');
    expect(result!.picked.version).toBe('1.0');
    expect(result!.picked.lastUpdated).toBe(data.lastUpdated);
    expect(Array.isArray(result!.picked.facts)).toBe(true);
  });

  it('不 rerank 时池宽仍 ≥ 20：section 不挤占 fact 名额、topK 取满', async () => {
    // 4 个 section 与 12 条 fact 都命中 query，section 的 tf 更高 → RRF 序里
    // section 占前 4。池宽若 = topK(8)，池里只剩 4 个 fact 名额、topK 取不满
    const facts = Array.from({ length: 12 }, (_, i) => fact(`事实${i} 婚礼`, 0.9, `f${i}`));
    const data = memory(facts, {
      user: {
        workContext: { summary: '', updatedAt: '' },
        personalContext: { summary: '', updatedAt: '' },
        topOfMind: { summary: '婚礼婚礼婚礼', updatedAt: '' },
      },
      history: {
        recentMonths: { summary: '婚礼婚礼婚礼', updatedAt: '' },
        earlierContext: { summary: '婚礼婚礼婚礼', updatedAt: '' },
        longTermBackground: { summary: '婚礼婚礼婚礼', updatedAt: '' },
      },
    });
    const result = await retrieveMemory(data, '婚礼', { topK: 8, collectTrace: true });
    expect(result!.picked.facts).toHaveLength(8); // 修复前只有 4
    expect(result!.trace!.poolSize).toBe(16); // 池宽上限 20，语料命中 16 条全进池
  });
});

describe('retrieveMemory 向量召回', () => {
  it('语义相关但词面不重叠的 fact 排到词面命中之上', async () => {
    const hybrid = memory([
      fact('用户喜欢烘焙面包', 0.9, 'fact_semantic', QUERY_VEC), // 词面 0 分，语义 1.0
      fact('用户正在研究量子计算', 0.9, 'fact_lexical'), // 词面部分命中，无向量
    ]);
    const result = await retrieveMemory(hybrid, '量子计算有什么进展', {
      queryEmbedding: QUERY_VEC,
    });
    expect(result).not.toBeNull();
    // 两路各 rank 0（rrf 平分），tie 稳定序路 A 在前
    expect(result!.picked.facts[0].id).toBe('fact_semantic');

    // 不给向量时语义 fact 无词面信号，不应入选（回归对照）
    const lexicalOnly = await retrieveMemory(hybrid, '量子计算有什么进展');
    expect(lexicalOnly!.picked.facts.map((f) => f.id)).toEqual(['fact_lexical']);
  });

  it('无向量的 fact 在向量供给时与纯词面行为一致（不被惩罚）', async () => {
    const data = memory([fact('量子计算研究', 0.9)]);
    const withVec = await retrieveMemory(data, '量子计算', { queryEmbedding: QUERY_VEC });
    const withoutVec = await retrieveMemory(data, '量子计算');
    expect(withVec!.picked.facts.map((f) => f.id)).toEqual(
      withoutVec!.picked.facts.map((f) => f.id),
    );
  });

  it('维度不匹配的向量被忽略（回落词面）', async () => {
    const data = memory([fact('量子计算研究', 0.9, 'f', [1, 0, 0])]); // 3 维 vs query 4 维
    const result = await retrieveMemory(data, '量子计算', {
      queryEmbedding: QUERY_VEC,
      collectTrace: true,
    });
    expect(result!.picked.facts.map((f) => f.id)).toEqual(['f']);
    expect(result!.trace!.vectorLeg).toBe('js'); // 无向量路命中，词面路补上
  });

  it('query 无有效 token 但有向量时不早退', async () => {
    const onlySemantic = memory([fact('用户偏爱简洁的代码风格', 0.9, 'f', QUERY_VEC)]);
    const result = await retrieveMemory(onlySemantic, '', { queryEmbedding: QUERY_VEC });
    expect(result).not.toBeNull();
    expect(result!.picked.facts[0].id).toBe('f');
    // 无向量时空 query 仍返回 null（回归对照）
    expect(await retrieveMemory(onlySemantic, '')).toBeNull();
  });

  /**
   * 门槛边界按实测标定锁定（见 retrieval.ts SEMANTIC_MATCH_THRESHOLD 注释）：
   * embedding-3 中文短文本的**无关基线**就在 0.44~0.55（如「今天天气不错适合出门散步」
   * ↔「用户的猫叫豆豆」= 0.550），真相关 0.64~0.69。门槛必须落在两者之间。
   */
  it('门槛取 0.6：无关基线量级（0.55）被挡下，真相关量级（0.65）放行', async () => {
    const baseline = memory([fact('完全无关的内容', 0.9, 'f', unit(0.55))]);
    expect(await retrieveMemory(baseline, '随便聊聊', { queryEmbedding: QUERY_VEC })).toBeNull();

    const relevant = memory([fact('完全无关的内容', 0.9, 'f', unit(0.65))]);
    const result = await retrieveMemory(relevant, '随便聊聊', { queryEmbedding: QUERY_VEC });
    expect(result!.picked.facts.map((f) => f.id)).toEqual(['f']);
  });

  it('门槛可配：调低放行 0.55，调高挡下 0.65', async () => {
    const data = memory([fact('完全无关的内容', 0.9, 'f', unit(0.55))]);
    expect(await retrieveMemory(data, '随便聊聊', { queryEmbedding: QUERY_VEC })).toBeNull();
    const low = await retrieveMemory(data, '随便聊聊', {
      queryEmbedding: QUERY_VEC,
      semanticMatchThreshold: 0.5,
    });
    expect(low!.picked.facts.map((f) => f.id)).toEqual(['f']);

    const relevant = memory([fact('完全无关的内容', 0.9, 'f', unit(0.65))]);
    expect(
      await retrieveMemory(relevant, '随便聊聊', {
        queryEmbedding: QUERY_VEC,
        semanticMatchThreshold: 0.7,
      }),
    ).toBeNull();
  });

  it('vectorRecall 正常返回 → vectorLeg=pg，召回结果被采纳', async () => {
    const data = memory([fact('无关内容', 0.9, 'f_near', unit(0.8))]);
    const recall = vi.fn(
      async (): Promise<VectorSearchResult[]> => [
        { kind: 'fact', refId: 'f_near', similarity: 0.8 },
      ],
    );
    const result = await retrieveMemory(data, '随便聊聊', {
      queryEmbedding: QUERY_VEC,
      vectorRecall: recall,
      collectTrace: true,
    });
    expect(result!.trace!.vectorLeg).toBe('pg');
    expect(result!.picked.facts.map((f) => f.id)).toEqual(['f_near']);
    expect(recall).toHaveBeenCalledWith(QUERY_VEC, 50);
  });

  it('vectorRecall 抛错 → warnOnce + JS 兜底（vectorLeg=js）且结果等价', async () => {
    const data = memory([fact('无关内容', 0.9, 'f', unit(0.8))]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await retrieveMemory(data, '随便聊聊', {
      queryEmbedding: QUERY_VEC,
      vectorRecall: async () => {
        throw new Error('pg down');
      },
      collectTrace: true,
    });
    expect(result!.trace!.vectorLeg).toBe('js');
    expect(result!.picked.facts.map((f) => f.id)).toEqual(['f']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('vectorRecall 失败计数进 stats；恢复 pg 后打 info 复位', async () => {
    resetMemoryRetrievalDegrades();
    resetMemoryDegradeStats();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const data = memory([fact('无关内容', 0.9, 'f', unit(0.8))]);
    let down = true;
    const recall = async (): Promise<VectorSearchResult[]> => {
      if (down) throw new Error('pg down');
      return [{ kind: 'fact', refId: 'f', similarity: 0.8 }];
    };

    await retrieveMemory(data, '随便聊聊', { queryEmbedding: QUERY_VEC, vectorRecall: recall });
    await retrieveMemory(data, '随便聊聊', { queryEmbedding: QUERY_VEC, vectorRecall: recall });
    expect(getMemoryDegradeStats().vectorFallbacks).toBe(2);

    // 恢复：一次 pg 成功 → 故障标记复位，打一次 info
    down = false;
    await retrieveMemory(data, '随便聊聊', { queryEmbedding: QUERY_VEC, vectorRecall: recall });
    expect(info).toHaveBeenCalledTimes(1);
    info.mockRestore();
    resetMemoryRetrievalDegrades();
  });

  it('vectorRecall 缺省 → 直接 JS 扫描（vectorLeg=js）', async () => {
    const data = memory([fact('无关内容', 0.9, 'f', unit(0.8))]);
    const result = await retrieveMemory(data, '随便聊聊', {
      queryEmbedding: QUERY_VEC,
      collectTrace: true,
    });
    expect(result!.trace!.vectorLeg).toBe('js');
    expect(result!.picked.facts.map((f) => f.id)).toEqual(['f']);
  });

  it('pgvector top-50 被 facts 占满时，语义命中的 section 仍被并入', async () => {
    const manyFacts = Array.from({ length: 50 }, (_, i) =>
      fact(`内容${i}`, 0.9, `f${i}`, unit(0.7 + i * 0.0001)),
    );
    const data = memory(manyFacts, {
      user: {
        workContext: { summary: '', updatedAt: '' },
        personalContext: { summary: '', updatedAt: '' },
        topOfMind: { summary: '最近在准备婚礼', updatedAt: '', embedding: QUERY_VEC },
      },
    });
    // 模拟 pgvector：只回 50 条 facts，不含 section（top-50 被占满）
    const recall = async (): Promise<VectorSearchResult[]> =>
      manyFacts.map((f, i) => ({
        kind: 'fact' as const,
        refId: f.id,
        similarity: 0.9 - i * 0.001,
      }));
    const result = await retrieveMemory(data, '怎么调试 Kubernetes 网络', {
      queryEmbedding: QUERY_VEC,
      vectorRecall: recall,
      collectTrace: true,
    });
    expect(result!.trace!.vectorLeg).toBe('pg');
    expect(result!.picked.user.topOfMind.summary).toContain('婚礼');
  });
});

describe('retrieveMemory rerank 精排', () => {
  // 三条 fact 词面全命中（RRF 序 = 数据序 a < b < c）
  const data = memory([
    fact('用户做量子计算研究', 0.9, 'a'),
    fact('用户研究量子计算的进展', 0.9, 'b'),
    fact('量子计算是用户的研究方向', 0.9, 'c'),
  ]);

  it('rerank 分数重排池序（同 confidence 时以 rerank 分定序）', async () => {
    const rerank = vi.fn(async () => [0.5, 0.9, 0.7]);
    const result = await retrieveMemory(data, '量子计算', { rerank, collectTrace: true });
    expect(result!.trace!.rerankUsed).toBe(true);
    expect(result!.picked.facts.map((f) => f.id)).toEqual(['b', 'c', 'a']);
    expect(rerank).toHaveBeenCalledWith('量子计算', [
      data.facts[0].content,
      data.facts[1].content,
      data.facts[2].content,
    ]);
  });

  it('rerank 返回 null → 保持 RRF 序（rerankUsed=false）', async () => {
    const result = await retrieveMemory(data, '量子计算', {
      rerank: async () => null,
      collectTrace: true,
    });
    expect(result!.trace!.rerankUsed).toBe(false);
    expect(result!.picked.facts.map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });

  it('rerank 抛错 → warnOnce + 保持 RRF 序', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await retrieveMemory(data, '量子计算', {
      rerank: async () => {
        throw new Error('api down');
      },
      collectTrace: true,
    });
    expect(result!.trace!.rerankUsed).toBe(false);
    expect(result!.picked.facts.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('rerank 失败计数进 stats；恢复后打 info 复位', async () => {
    resetMemoryRetrievalDegrades();
    resetMemoryDegradeStats();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    let down = true;
    const rerank = async (): Promise<number[] | null> => {
      if (down) throw new Error('api down');
      return [0.9, 0.8, 0.7];
    };

    await retrieveMemory(data, '量子计算', { rerank });
    await retrieveMemory(data, '量子计算', { rerank });
    expect(getMemoryDegradeStats().rerankFailures).toBe(2);

    down = false;
    const result = await retrieveMemory(data, '量子计算', { rerank, collectTrace: true });
    expect(result!.trace!.rerankUsed).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
    info.mockRestore();
    resetMemoryRetrievalDegrades();
  });

  it('confidence 加权作用在 rerank 分上（同分高置信在前）', async () => {
    const confData = memory([
      fact('用户做量子计算研究', 0.5, 'low'),
      fact('用户研究量子计算的进展', 0.9, 'high'),
    ]);
    const result = await retrieveMemory(confData, '量子计算', { rerank: async () => [0.9, 0.9] });
    expect(result!.picked.facts.map((f) => f.id)).toEqual(['high', 'low']);
  });

  it('池尾接续倒数排名分：topK > 20 时尾段不反超池头', async () => {
    // 22 条 fact 词面同分（同 CJK token 集）、向量同分（均 unit(0.9)）：
    // 双路各列数据序 → RRF = 2/(61+i)，池尾 m20/m21 高达 ~0.0247/0.0244。
    // 若池尾沿用 RRF 分，会反超精排池头（1/61..1/80 = 0.0164..0.0125），
    // rerank 一开尾段反而窜进 topK 前部——接续名次分后按 m0..m21 单调
    const many = memory(
      Array.from({ length: 22 }, (_, i) => fact(`量子计算方向 ${i}`, 0.9, `m${i}`, unit(0.9))),
    );
    const result = await retrieveMemory(many, '量子计算', {
      queryEmbedding: QUERY_VEC,
      rerank: async () => Array.from({ length: 20 }, (_, i) => 1 - i * 0.01),
      topK: 22,
      collectTrace: true,
    });
    expect(result!.trace!.rerankUsed).toBe(true);
    const pickedIds = result!.picked.facts.map((f) => f.id);
    expect(pickedIds.slice(0, 2)).toEqual(['m0', 'm1']);
    expect(pickedIds.slice(-2)).toEqual(['m20', 'm21']);
    const rerankByRef = new Map(result!.trace!.pool.map((e) => [e.ref, e.rerank]));
    expect(rerankByRef.get('fact:m19')).toBeCloseTo(1 / 80, 10);
    expect(rerankByRef.get('fact:m20')).toBeCloseTo(1 / 81, 10);
    expect(rerankByRef.get('fact:m21')).toBeCloseTo(1 / 82, 10);
  });

  it('rerankQuery 显式传入时用于调用（而非拼接的词面 query）', async () => {
    const rerank = vi.fn(async () => [0.1, 0.2, 0.3]);
    await retrieveMemory(data, '量子计算 有什么 进展', { rerank, rerankQuery: '量子计算' });
    expect(rerank).toHaveBeenCalledWith('量子计算', expect.any(Array));
  });
});
