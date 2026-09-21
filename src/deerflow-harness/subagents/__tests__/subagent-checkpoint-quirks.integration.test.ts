import { describe, expect, it } from 'vitest';
import { createAgent, FakeToolCallingModel } from 'langchain';
import { MemorySaver } from '@langchain/langgraph';

/**
 * 绊线测试：LangGraph 顶层图 checkpoint 行为约束
 *
 * 记录「为什么 subagent 子图不挂 checkpointer、也不做 ns 隔离」的实测依据
 * （见 executor.ts 的 buildSubagentStreamConfig 注释）。这些是**框架行为**
 * 断言：若未来升级 @langchain/langgraph 后行为改变（例如顶层图开始尊重
 * checkpoint_ns），本文件会失败 —— 那时就可以重新评估「父子共享 checkpoint」
 * 方案，而不是现在这样被动沿用结论。
 *
 * 用 FakeToolCallingModel 跑真实 graph，不依赖 PG 与真实 LLM。
 */
const makeAgent = (checkpointer: MemorySaver) =>
  createAgent({ model: new FakeToolCallingModel(), tools: [], checkpointer });

const invoke = (agent: ReturnType<typeof makeAgent>, content: string, configurable: object) =>
  agent.invoke({ messages: [{ role: 'user', content }] }, { configurable });

/** 读取图状态里的消息文本（getState 的返回类型为框架内部泛型，此处按需收窄）。 */
async function readStateTexts(
  agent: ReturnType<typeof makeAgent>,
  threadId: string,
): Promise<string[]> {
  const state = (await agent.getState({ configurable: { thread_id: threadId } })) as {
    values?: { messages?: Array<{ content?: unknown }> };
  };
  return (state.values?.messages ?? [])
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .filter((text) => text.length > 0);
}

describe('约束 1：顶层图忽略调用方传入的 checkpoint_ns', () => {
  it('传入 checkpoint_ns 仍落在根命名空间', async () => {
    const checkpointer = new MemorySaver();
    const agent = makeAgent(checkpointer);

    await invoke(agent, 'hi', { thread_id: 't1', checkpoint_ns: 'subagent:task-a' });

    const namespaces = new Set<string>();
    for await (const cp of checkpointer.list({ configurable: { thread_id: 't1' } })) {
      namespaces.add((cp.config.configurable?.checkpoint_ns as string) ?? '');
    }

    // 若此断言失败：LangGraph 已支持顶层图命名空间隔离 → 可重启「共享 checkpoint」方案
    expect([...namespaces]).toEqual(['']);
  }, 30_000);
});

describe('约束 2：父子图共用 thread_id 会污染父图状态', () => {
  it('子图的消息被并入父图消息历史，父图 head 指向子图那一轮', async () => {
    const checkpointer = new MemorySaver();
    const parent = makeAgent(checkpointer);
    const child = makeAgent(checkpointer);

    await invoke(parent, 'parent question', { thread_id: 'shared' });
    await invoke(child, 'child question', { thread_id: 'shared' });

    const texts = await readStateTexts(parent, 'shared');

    // messages reducer 是追加语义：两轮对话被并入同一条消息历史，
    // 且父图的 head/latest 落到了子 agent 那一轮（父图后续 run 会看到
    // 子 agent 的内部消息，resume 也会指向错误位置）。
    // 若此断言失败：共用 thread_id 已不再互相干扰 → 可重新评估子图落盘方案
    expect(texts).toContain('parent question');
    expect(texts).toContain('child question');
    expect(texts.at(-1)).not.toBe('parent question');
  }, 30_000);
});
