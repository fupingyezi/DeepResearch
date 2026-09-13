import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MEMORY_CONFIG, setMemoryConfig } from './config';
import { getMemoryStorage, resetMemoryStorage } from './storage';
import { createMemoryFact, MemoryUpdater, setMemoryModelFactory } from './updater';

/** formatConversationForUpdate 依赖 _getType 识别 human/ai 角色。 */
function humanMsg(content: string) {
  return { _getType: () => 'human' as const, content };
}

/** 假 chat model：固定返回 newFacts 里的一条给定 content。 */
function fakeModelWithFact(content: string): BaseChatModel {
  return {
    invoke: async () => ({
      content: JSON.stringify({
        newFacts: [{ content, category: 'context', confidence: 0.9 }],
      }),
    }),
  } as unknown as BaseChatModel;
}

describe('updater fact 去重键（casefold）', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-dedup-test-'));
    setMemoryConfig({
      ...DEFAULT_MEMORY_CONFIG,
      storagePath: path.join(tmpDir, 'memory.json'),
      embeddingEnabled: false,
    });
    resetMemoryStorage();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    setMemoryModelFactory(null);
    resetMemoryStorage();
    setMemoryConfig({ ...DEFAULT_MEMORY_CONFIG });
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  /** 预置一条 fact，再让 LLM 返回 incoming，返回更新后的 facts。 */
  async function dedupRound(existing: string, incoming: string, userId: string) {
    await createMemoryFact(existing, 'context', 0.9, null, userId);
    setMemoryModelFactory(() => fakeModelWithFact(incoming));
    const ok = await new MemoryUpdater().updateMemory([humanMsg('随便聊聊')], { userId });
    expect(ok).toBe(true);
    return (await getMemoryStorage().reload({ userId })).facts;
  }

  it('ß vs ss 判为同一条', async () => {
    const facts = await dedupRound('Straße 是德语词汇', 'STRASSE 是德语词汇', 'u1');
    expect(facts).toHaveLength(1);
  });

  it('连字 ﬁ 与展开写法判为同一条', async () => {
    const facts = await dedupRound('ﬁle 是连字', 'file 是连字', 'u2');
    expect(facts).toHaveLength(1);
  });

  // 全大写收尾的 Σ 在 toLowerCase 下会折成词尾 ς（'λογος'），与写法为正体 σ 的
  // 'λογοσ' 对不上；casefold 把两者都归一成 σ 才能判成同一条。
  it('希腊语 σ/ς 写法差异判为同一条', async () => {
    const facts = await dedupRound('ΛΟΓΟΣ 是希腊语', 'λογοσ 是希腊语', 'u3');
    expect(facts).toHaveLength(1);
  });

  // 组合字符与预组合字符（NFC vs NFD）也要判成同一条：模型两次输出可能用了不同写法
  it('é 的预组合写法与组合写法判为同一条', async () => {
    // 用转义序列写：源码里两种写法肉眼难辨，被编辑器归一化后会变成恒真测试
    const composed = 'caf\u00e9 是法语词汇'; // é 预组合
    const decomposed = 'cafe\u0301 是法语词汇'; // e + 组合尖音符
    const facts = await dedupRound(composed, decomposed, 'u5');
    expect(facts).toHaveLength(1);
  });

  it('内容确实不同的两条仍然都保留', async () => {
    const facts = await dedupRound('用户偏好 pnpm', '用户偏好 npm', 'u4');
    expect(facts.map((f) => f.content).sort()).toEqual(['用户偏好 npm', '用户偏好 pnpm']);
  });
});
