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
import { getMemoryStorage, resetMemoryStorage, setMemoryStorage } from '../storage';
import {
  createMemoryFact,
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
});
