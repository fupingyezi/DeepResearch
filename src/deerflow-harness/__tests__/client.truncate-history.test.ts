import { describe, expect, it } from 'vitest';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { END, MemorySaver, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';

import { DeerFlowClient } from '../client';
import type { ModelConfig } from '../types';

/**
 * checkpoint 截断（recall / reEditCall 重跑前）的行为锁定。用确定性 echo 图 +
 * MemorySaver 种历史，与生产 DeerFlowClient 共享同一 checkpointer，不经 PG 与
 * 真实 LLM。
 *
 * - 每被删消息一条 RemoveMessage：messagesStateReducer 只移除 id 精确命中的那一条
 *   （没有批量语义），id 不存在会抛错——因此实现先 getState 找锚点。
 * - updateState 必须走 START 哨兵：不带 asNode（或给真实节点名）会把更新经节点
 *   写手路由到模型/中间件。这些是框架行为断言：@langchain/langgraph 升级后行为
 *   若变（例如 reducer 支持区间删除），本文件会失败，届时可简化实现。
 */

const modelConfig = { modelName: 'test-model' } as ModelConfig;

const THREAD = 't-truncate';

/** 确定性种子图：每条 human 后补一条 echo AIMessage，消息形状可控。 */
function makeSeedGraph(saver: MemorySaver) {
  const echo = (state: { messages: BaseMessage[] }) => {
    const lastHuman = [...state.messages].reverse().find((m) => m._getType() === 'human');
    return { messages: [new AIMessage({ content: `答:${String(lastHuman?.content ?? '')}` })] };
  };
  return new StateGraph(MessagesAnnotation)
    .addNode('echo', echo)
    .addEdge(START, 'echo')
    .addEdge('echo', END)
    .compile({ checkpointer: saver });
}

type SeedGraph = ReturnType<typeof makeSeedGraph>;

async function readState(
  graph: SeedGraph,
  threadId: string,
): Promise<{ count: number; humanTexts: string[] }> {
  const state = (await graph.getState({ configurable: { thread_id: threadId } })) as {
    values?: { messages?: BaseMessage[] };
  };
  const messages = state.values?.messages ?? [];
  return {
    count: messages.length,
    humanTexts: messages
      .filter((m) => m._getType() === 'human')
      .map((m) => (typeof m.content === 'string' ? m.content : '')),
  };
}

const invokeTurn = (graph: SeedGraph, content: string) =>
  graph.invoke({ messages: [{ role: 'user', content }] }, { configurable: { thread_id: THREAD } });

describe('truncateHistoryBeforeLatestUserMessage', () => {
  it('移除最近 human 起至结尾，截断点之前的历史保留', async () => {
    const saver = new MemorySaver();
    const seed = makeSeedGraph(saver);
    await invokeTurn(seed, 'Q1');
    await invokeTurn(seed, 'Q2');

    const before = await readState(seed, THREAD);
    expect(before.count).toBe(4);
    expect(before.humanTexts).toEqual(['Q1', 'Q2']);

    const client = new DeerFlowClient(modelConfig, { checkpointer: saver });
    const truncated = await client.truncateHistoryBeforeLatestUserMessage(THREAD);

    expect(truncated).toBe(true);
    const after = await readState(seed, THREAD);
    expect(after.humanTexts).toEqual(['Q1']);
    expect(after.count).toBe(2);
  }, 30_000);

  it('仅一条 human：截到空历史', async () => {
    const saver = new MemorySaver();
    const seed = makeSeedGraph(saver);
    await invokeTurn(seed, 'Q1');

    const client = new DeerFlowClient(modelConfig, { checkpointer: saver });
    expect(await client.truncateHistoryBeforeLatestUserMessage(THREAD)).toBe(true);
    expect((await readState(seed, THREAD)).count).toBe(0);
  }, 30_000);

  it('没有 human 消息（空线程）→ false，不抛错', async () => {
    const saver = new MemorySaver();
    const client = new DeerFlowClient(modelConfig, { checkpointer: saver });
    await expect(client.truncateHistoryBeforeLatestUserMessage('t-empty')).resolves.toBe(false);
  }, 30_000);
});
