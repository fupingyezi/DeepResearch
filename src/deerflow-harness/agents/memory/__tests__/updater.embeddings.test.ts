import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Embeddings } from '@langchain/core/embeddings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MEMORY_CONFIG, setMemoryConfig } from '../config';
import {
  normalizeVector,
  resetMemoryEmbeddingsFactory,
  setMemoryEmbeddingsFactory,
} from '../embeddings';
import { PgMemoryStorage } from '../pg-storage';
import {
  getMemoryStorage,
  resetMemoryStorage,
  setMemoryStorage,
  type MemoryStorage,
} from '../storage';
import {
  createMemoryFact,
  getMemoryUpdateStats,
  MemoryUpdater,
  setMemoryModelFactory,
  updateMemoryFact,
} from '../updater';
import { FakeSql } from './fake-sql';

const DIMS = 4;

/** formatConversationForUpdate 依赖 _getType 识别 human/ai 角色。 */
function humanMsg(content: string) {
  return { _getType: () => 'human' as const, content };
}

/** 单位向量（embedTexts 出口归一化后落盘值即此形态）。 */
function vec(seed: number): number[] {
  const raw = Array.from({ length: DIMS }, (_, i) => (i === 0 ? seed : seed / 2));
  return normalizeVector(raw);
}

/** 记录 prompt 的假 chat model：返回固定 JSON 文本。 */
function fakeModel(responseText: string, capturedPrompts: string[]): BaseChatModel {
  return {
    invoke: async (prompt: unknown) => {
      capturedPrompts.push(String(prompt));
      return { content: responseText };
    },
  } as unknown as BaseChatModel;
}

/** 行为可注入的假 Embeddings。 */
function fakeEmbeddings(behavior: (texts: string[]) => Promise<number[][]>): Embeddings {
  return {
    embedDocuments: behavior,
    embedQuery: async (t: string) => (await behavior([t]))[0],
  } as unknown as Embeddings;
}

describe('updater 写侧嵌入', () => {
  const prompts: string[] = [];

  beforeEach(() => {
    setMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, embeddingDimensions: DIMS });
    setMemoryStorage(new PgMemoryStorage(new FakeSql()));
    prompts.length = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    setMemoryModelFactory(null);
    resetMemoryEmbeddingsFactory();
    resetMemoryStorage();
    setMemoryConfig({ ...DEFAULT_MEMORY_CONFIG });
    vi.restoreAllMocks();
  });

  it('LLM 更新的 newFacts 落盘时带向量', async () => {
    setMemoryModelFactory(() =>
      fakeModel(
        JSON.stringify({
          user: {},
          history: {},
          newFacts: [
            { content: '用户偏好用 pnpm 管理依赖', category: 'preference', confidence: 0.9 },
          ],
        }),
        prompts,
      ),
    );
    setMemoryEmbeddingsFactory(() => fakeEmbeddings(async (texts) => texts.map(() => vec(1))));

    const ok = await new MemoryUpdater().updateMemory([humanMsg('我用 pnpm')], { userId: 'u1' });
    expect(ok).toBe(true);

    const saved = await getMemoryStorage().reload({ userId: 'u1' });
    expect(saved.facts).toHaveLength(1);
    expect(saved.facts[0].embedding).toEqual(vec(1));
  });

  it('注入 LLM 的 current_memory 剥离了 embedding 字段（防 MB 级 prompt）', async () => {
    // 预置一条带向量的 fact 与一个带向量的 section
    await createMemoryFact('既有事实', 'context', 0.9, null, 'u2');
    const scope = { agentName: null, userId: 'u2' };
    const preset = await getMemoryStorage().reload(scope);
    preset.user.topOfMind = { summary: '既有关注点', updatedAt: '', embedding: vec(3) };
    await getMemoryStorage().save(preset, scope);
    setMemoryModelFactory(() => fakeModel(JSON.stringify({ newFacts: [] }), prompts));

    const ok = await new MemoryUpdater().updateMemory([humanMsg('随便聊聊')], { userId: 'u2' });
    expect(ok).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('embedding');
  });

  it('嵌入 API 失败时 updateMemory 仍成功保存（无向量，等回填）', async () => {
    setMemoryModelFactory(() =>
      fakeModel(
        JSON.stringify({
          newFacts: [{ content: '失败场景事实', category: 'context', confidence: 0.9 }],
        }),
        prompts,
      ),
    );
    setMemoryEmbeddingsFactory(() =>
      fakeEmbeddings(async () => {
        throw new Error('embed api down');
      }),
    );

    const ok = await new MemoryUpdater().updateMemory([humanMsg('测试')], { userId: 'u3' });
    expect(ok).toBe(true);
    const saved = await getMemoryStorage().reload({ userId: 'u3' });
    expect(saved.facts[0].content).toBe('失败场景事实');
    expect(saved.facts[0].embedding).toBeUndefined();
  });

  it('createMemoryFact 附带向量；嵌入失败不阻塞创建', async () => {
    setMemoryEmbeddingsFactory(() => fakeEmbeddings(async (texts) => texts.map(() => vec(2))));
    const created = await createMemoryFact('手动事实', 'context', 0.8, null, 'u4');
    expect(created.facts[0].embedding).toEqual(vec(2));

    // 换成失败的工厂：创建仍成功
    setMemoryEmbeddingsFactory(() =>
      fakeEmbeddings(async () => {
        throw new Error('down');
      }),
    );
    const created2 = await createMemoryFact('失败也创建', 'context', 0.8, null, 'u4');
    expect(created2.facts[1].embedding).toBeUndefined();
  });

  it('updateMemoryFact 改 content：旧向量清除、写入新向量', async () => {
    setMemoryEmbeddingsFactory(() =>
      fakeEmbeddings(async (texts) => texts.map((t) => vec(t.length))),
    );
    const created = await createMemoryFact('原始内容', 'context', 0.8, null, 'u5');
    const factId = created.facts[0].id;

    const updated = await updateMemoryFact(factId, { content: '改后的内容' }, null, 'u5');
    const target = updated.facts.find((f) => f.id === factId)!;
    expect(target.content).toBe('改后的内容');
    expect(target.embedding).toEqual(vec('改后的内容'.length)); // 新向量
  });

  it('updateMemoryFact 只改 confidence 时向量不动', async () => {
    setMemoryEmbeddingsFactory(() => fakeEmbeddings(async (texts) => texts.map(() => vec(9))));
    const created = await createMemoryFact('稳定内容', 'context', 0.8, null, 'u6');
    const factId = created.facts[0].id;

    const updated = await updateMemoryFact(factId, { confidence: 0.95 }, null, 'u6');
    const target = updated.facts.find((f) => f.id === factId)!;
    expect(target.embedding).toEqual(vec(9)); // 原向量保留
    expect(target.confidence).toBe(0.95);
  });

  it('updateMemoryFact 相同 content 不删向量（内容未变不重嵌）', async () => {
    setMemoryEmbeddingsFactory(() => fakeEmbeddings(async (texts) => texts.map(() => vec(7))));
    const created = await createMemoryFact('稳定内容', 'context', 0.8, null, 'u10');
    const factId = created.facts[0].id;

    const updated = await updateMemoryFact(factId, { content: '稳定内容' }, null, 'u10');
    const target = updated.facts.find((f) => f.id === factId)!;
    expect(target.content).toBe('稳定内容');
    expect(target.embedding).toEqual(vec(7)); // 未变：原向量保留（旧实现无条件 delete）
  });

  it('updateMemoryFact 预嵌失败：content 已更新、向量清空（回填兜底）', async () => {
    setMemoryEmbeddingsFactory(() => fakeEmbeddings(async (texts) => texts.map(() => vec(7))));
    const created = await createMemoryFact('原始内容', 'context', 0.8, null, 'u11');
    const factId = created.facts[0].id;

    setMemoryEmbeddingsFactory(() =>
      fakeEmbeddings(async () => {
        throw new Error('embed api down');
      }),
    );
    const updated = await updateMemoryFact(factId, { content: '新的内容' }, null, 'u11');
    const target = updated.facts.find((f) => f.id === factId)!;
    expect(target.content).toBe('新的内容');
    expect(target.embedding).toBeUndefined(); // 预嵌失败：无向量落盘，回填重试
  });

  it('updateMemoryFact 的嵌入在 update 事务（mutator）之外发起', async () => {
    // 记录 embed 调用是否发生在 mutator 执行期间：修复前在 mutator 内 await embedQuery
    // （持行锁调 HTTP），标记会为 true
    const base = new PgMemoryStorage(new FakeSql());
    let inMutator = false;
    const embedDuringMutator: boolean[] = [];
    const trackingStorage: MemoryStorage = {
      load: (o) => base.load(o),
      reload: (o) => base.reload(o),
      save: (d, o) => base.save(d, o),
      update: async (mutator, o) =>
        base.update(async (fresh) => {
          inMutator = true;
          try {
            return await mutator(fresh);
          } finally {
            inMutator = false;
          }
        }, o),
    };
    setMemoryStorage(trackingStorage);
    setMemoryEmbeddingsFactory(() =>
      fakeEmbeddings(async (texts) => {
        embedDuringMutator.push(inMutator);
        return texts.map(() => vec(3));
      }),
    );

    const created = await createMemoryFact('初始内容', 'context', 0.8, null, 'u12');
    const factId = created.facts[0].id;
    embedDuringMutator.length = 0; // 只看 updateMemoryFact 这一次的嵌入时机

    const updated = await updateMemoryFact(factId, { content: '改写内容' }, null, 'u12');
    const target = updated.facts.find((f) => f.id === factId)!;
    expect(target.embedding).toEqual(vec(3));
    // 嵌入确实发生，且没有一次发生在 mutator（行锁持有期）内
    expect(embedDuringMutator.length).toBeGreaterThan(0);
    expect(embedDuringMutator.every((during) => !during)).toBe(true);
  });

  it('LLM 重写 section 时旧向量作废并重嵌；未触碰的 section 旧向量保留', async () => {
    const scope = { agentName: null, userId: 'u7' };
    const preset = {
      version: '1.0' as const,
      lastUpdated: '2026-01-01T00:00:00.000Z',
      user: {
        workContext: { summary: '', updatedAt: '' },
        personalContext: { summary: '', updatedAt: '' },
        topOfMind: { summary: '旧关注点', updatedAt: '', embedding: vec(9) },
      },
      history: {
        recentMonths: { summary: '最近在做的项目', updatedAt: '', embedding: vec(8) },
        earlierContext: { summary: '', updatedAt: '' },
        longTermBackground: { summary: '', updatedAt: '' },
      },
      facts: [],
    };
    await getMemoryStorage().save(preset, scope);

    setMemoryModelFactory(() =>
      fakeModel(
        JSON.stringify({
          user: { topOfMind: { summary: '新的关注点', shouldUpdate: true } },
          history: {},
          newFacts: [],
        }),
        prompts,
      ),
    );
    setMemoryEmbeddingsFactory(() => fakeEmbeddings(async (texts) => texts.map(() => vec(1))));

    const ok = await new MemoryUpdater().updateMemory([humanMsg('聊聊近况')], { userId: 'u7' });
    expect(ok).toBe(true);

    const saved = await getMemoryStorage().reload(scope);
    expect(saved.user.topOfMind.summary).toBe('新的关注点');
    expect(saved.user.topOfMind.embedding).toEqual(vec(1)); // 重写后重嵌
    expect(saved.history.recentMonths.embedding).toEqual(vec(8)); // 未触碰：旧向量保留
  });

  it('LLM shouldUpdate 但 summary 未变时整槽保留（连同旧向量，不重嵌）', async () => {
    const scope = { agentName: null, userId: 'u8' };
    const preset = {
      version: '1.0' as const,
      lastUpdated: '2026-01-01T00:00:00.000Z',
      user: {
        workContext: { summary: '', updatedAt: '' },
        personalContext: { summary: '', updatedAt: '' },
        topOfMind: { summary: '稳定的关注点', updatedAt: '', embedding: vec(7) },
      },
      history: {
        recentMonths: { summary: '', updatedAt: '' },
        earlierContext: { summary: '', updatedAt: '' },
        longTermBackground: { summary: '', updatedAt: '' },
      },
      facts: [],
    };
    await getMemoryStorage().save(preset, scope);

    setMemoryModelFactory(() =>
      fakeModel(
        JSON.stringify({
          user: { topOfMind: { summary: ' 稳定的关注点 ', shouldUpdate: true } }, // trim 后同文
          newFacts: [],
        }),
        prompts,
      ),
    );
    setMemoryEmbeddingsFactory(() => fakeEmbeddings(async (texts) => texts.map(() => vec(1))));

    const ok = await new MemoryUpdater().updateMemory([humanMsg('聊聊近况')], { userId: 'u8' });
    expect(ok).toBe(true);

    const saved = await getMemoryStorage().reload(scope);
    expect(saved.user.topOfMind.embedding).toEqual(vec(7)); // 未变：原槽连同旧向量保留
  });

  it('section summary 被 stripUploadMentions 改写时旧向量失效并按新文本重嵌', async () => {
    const scope = { agentName: null, userId: 'u9' };
    const preset = {
      version: '1.0' as const,
      lastUpdated: '2026-01-01T00:00:00.000Z',
      user: {
        workContext: { summary: '', updatedAt: '' },
        personalContext: { summary: '', updatedAt: '' },
        topOfMind: { summary: '在准备婚礼。', updatedAt: '', embedding: vec(9) },
      },
      history: {
        recentMonths: {
          summary: 'uploaded a file for review. 也在做性能优化。',
          updatedAt: '',
          embedding: vec(9),
        },
        earlierContext: { summary: '', updatedAt: '' },
        longTermBackground: { summary: '', updatedAt: '' },
      },
      facts: [],
    };
    await getMemoryStorage().save(preset, scope);

    setMemoryModelFactory(() => fakeModel(JSON.stringify({ newFacts: [] }), prompts));
    setMemoryEmbeddingsFactory(() =>
      fakeEmbeddings(async (texts) => texts.map((t) => vec(t.length))),
    );

    const ok = await new MemoryUpdater().updateMemory([humanMsg('继续')], { userId: 'u9' });
    expect(ok).toBe(true);

    const saved = await getMemoryStorage().reload(scope);
    const summary = saved.history.recentMonths.summary;
    expect(summary).not.toContain('uploaded');
    // strip 后按清洗过的文本重嵌（向量 seed = 清洗后文本长度），而非沿用旧 vec(9)
    expect(saved.history.recentMonths.embedding).toEqual(vec(summary.length));
    // 未被 strip 的 section 不受影响
    expect(saved.user.topOfMind.embedding).toEqual(vec(9));
  });

  it('stripUploadMentions 命中 /mnt 路径与 <uploaded_files> 标签事实；多条目无 lastIndex 串扰', async () => {
    // 顺序即不变量：f-late 命中后旧实现的共享 lastIndex 停在 18，f-en 的匹配位在 0 < 18
    // 被漏检；f-path / f-tag 以非词字符开头，旧实现组外 \b 下永不命中
    const scope = { agentName: null, userId: 'u13' };
    const preset = {
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
      facts: [
        {
          id: 'f-late',
          content: '本次讨论重点是 upload file 的流程改进',
          category: 'context' as const,
          confidence: 0.8,
          createdAt: '2026-01-01T00:00:00.000Z',
          source: 'test',
        },
        {
          id: 'f-en',
          content: 'uploaded a file for review.',
          category: 'context' as const,
          confidence: 0.8,
          createdAt: '2026-01-01T00:00:00.000Z',
          source: 'test',
        },
        {
          id: 'f-path',
          content: '参考文件在 /mnt/user-data/uploads/report.pdf',
          category: 'context' as const,
          confidence: 0.8,
          createdAt: '2026-01-01T00:00:00.000Z',
          source: 'test',
        },
        {
          id: 'f-tag',
          content: '附件见 <uploaded_files> 里的文件',
          category: 'context' as const,
          confidence: 0.8,
          createdAt: '2026-01-01T00:00:00.000Z',
          source: 'test',
        },
        {
          id: 'f-keep',
          content: '用户偏好用 pnpm 管理依赖',
          category: 'context' as const,
          confidence: 0.8,
          createdAt: '2026-01-01T00:00:00.000Z',
          source: 'test',
        },
      ],
    };
    await getMemoryStorage().save(preset, scope);

    setMemoryModelFactory(() => fakeModel(JSON.stringify({ newFacts: [] }), prompts));
    setMemoryEmbeddingsFactory(() => fakeEmbeddings(async (texts) => texts.map(() => vec(1))));

    const ok = await new MemoryUpdater().updateMemory([humanMsg('继续')], { userId: 'u13' });
    expect(ok).toBe(true);

    const saved = await getMemoryStorage().reload(scope);
    expect(saved.facts.map((f) => f.content)).toEqual(['用户偏好用 pnpm 管理依赖']);
  });

  it('LLM 调用超时被 signal 打断：本轮记失败，队列不卡', async () => {
    // updateTimeoutMs=50：invoke 返回的 Promise 尊重 signal，abort 时 reject
    setMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, embeddingDimensions: DIMS, updateTimeoutMs: 50 });
    setMemoryModelFactory(() => {
      return {
        invoke: (_prompt: unknown, opts?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('The operation timed out', 'TimeoutError')),
              { once: true },
            );
          }),
      } as unknown as BaseChatModel;
    });

    const failedBefore = getMemoryUpdateStats().failed;
    const ok = await new MemoryUpdater().updateMemory([humanMsg('你好')], { userId: 'timeout1' });
    expect(ok).toBe(false);
    expect(getMemoryUpdateStats().failed).toBe(failedBefore + 1);
  });

  it('无变更轮次返回原引用：跳过落盘写（无 UPSERT / 向量重建）', async () => {
    // applyUpdates/stripUploadMentions 无变更时返回原引用，pg-storage.update
    // 的 `next === current` 判等生效——否则每轮无变更更新也会全量重写
    const fake = new FakeSql();
    setMemoryStorage(new PgMemoryStorage(fake));
    setMemoryModelFactory(() =>
      fakeModel(JSON.stringify({ newFacts: [], user: {}, history: {} }), prompts),
    );

    const ok = await new MemoryUpdater().updateMemory([humanMsg('随便聊聊')], {
      userId: 'nc1',
    });
    expect(ok).toBe(true);

    // 仅剩 readLocked 的造行 INSERT（DO NOTHING）；UPSERT 与向量重建都没发生
    const stateInserts = fake.calls.filter((c) => c.trim().startsWith('INSERT INTO memory_state'));
    expect(stateInserts).toHaveLength(1);
    expect(stateInserts[0]).toContain('DO NOTHING');
    expect(fake.calls.some((c) => c.trim().startsWith('DELETE FROM memory_vectors'))).toBe(false);
  });

  it('存储写失败（update 返回 null）计入 failed，attempted = succeeded + failed', async () => {
    const base = new PgMemoryStorage(new FakeSql());
    const failingStorage: MemoryStorage = {
      load: (o) => base.load(o),
      reload: (o) => base.reload(o),
      save: (d, o) => base.save(d, o),
      update: async () => null,
    };
    setMemoryStorage(failingStorage);
    setMemoryModelFactory(() => fakeModel(JSON.stringify({ newFacts: [] }), prompts));

    const before = getMemoryUpdateStats();
    const ok = await new MemoryUpdater().updateMemory([humanMsg('你好')], { userId: 'wf1' });
    expect(ok).toBe(false);
    const after = getMemoryUpdateStats();
    expect(after.attempted).toBe(before.attempted + 1);
    expect(after.failed).toBe(before.failed + 1);
    expect(after.succeeded).toBe(before.succeeded);
  });

  it('嵌入 HTTP 在 update 事务（mutator）之外发起', async () => {
    // 包一层 storage 记录「embed 调用是否发生在 mutator 执行期间」：
    // 修复前 embedMissing* 在 mutator 内 await（持行锁调 HTTP），标记会为 true
    const base = new PgMemoryStorage(new FakeSql());
    let inMutator = false;
    const embedDuringMutator: boolean[] = [];
    const trackingStorage: MemoryStorage = {
      load: (o) => base.load(o),
      reload: (o) => base.reload(o),
      save: (d, o) => base.save(d, o),
      update: async (mutator, o) =>
        base.update(async (fresh) => {
          inMutator = true;
          try {
            return await mutator(fresh);
          } finally {
            inMutator = false;
          }
        }, o),
    };
    setMemoryStorage(trackingStorage);
    setMemoryModelFactory(() =>
      fakeModel(
        JSON.stringify({
          newFacts: [{ content: '锁外嵌入事实', category: 'context', confidence: 0.9 }],
        }),
        prompts,
      ),
    );
    setMemoryEmbeddingsFactory(() =>
      fakeEmbeddings(async (texts) => {
        embedDuringMutator.push(inMutator);
        return texts.map(() => vec(1));
      }),
    );

    const ok = await new MemoryUpdater().updateMemory([humanMsg('你好')], { userId: 'p01' });
    expect(ok).toBe(true);
    // 嵌入确实发生，且没有一次发生在 mutator（行锁持有期）内
    expect(embedDuringMutator.length).toBeGreaterThan(0);
    expect(embedDuringMutator.every((during) => !during)).toBe(true);

    const saved = await getMemoryStorage().reload({ userId: 'p01' });
    expect(saved.facts[0].embedding).toEqual(vec(1));
  });
});
