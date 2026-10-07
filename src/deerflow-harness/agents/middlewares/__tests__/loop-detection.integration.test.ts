import { describe, expect, it, beforeEach } from 'vitest';
import { createAgent, FakeToolCallingModel, tool } from 'langchain';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import z from 'zod';

import { loopDetectionMiddleware } from '../loop-detection-middleware';

/**
 * 绊线测试：硬停 jumpTo 行为约束（真实 graph 端到端）
 *
 * 硬停若直接 END，run 会以「只有工具活动、没有回答」的面目收场——中间件对
 * state 的改写不产生 SSE 事件。首次硬停必须跳回模型再走一轮生成；用
 * FakeToolCallingModel 跑真实 graph 验证：
 *  - canJumpTo: ['model'] + jumpTo: 'model' 是框架认可的**用户面值**（TS 类型
 *    JumpToTarget = "model" | "tools" | "end"），afterModel 路由对非 END/非
 *    'tools' 的 jumpTo 一律 Send("model_request")——若框架改为只接受运行时面值
 *    "model_request"，本测试会在「Invalid jump target」处失败。
 *  - 跳回后模型再次调工具时，第二次硬停剥离 tool_calls 终止图形（不跳转），
 *    由路由器的「无 tool_calls 的 AIMessage → exit」判定收尾。
 *
 * 模型调用次数经 indexRef 观测：bindTools 会用 `new FakeToolCallingModel(...)`
 * 克隆实例（子类会被丢掉），但克隆共享同一个 indexRef 引用，每轮生成 index+1。
 * 7 个条目下恰好 6 次调用后 indexRef.current === 6（第 7 次才会绕回 0）。
 */

const fakeSearch = tool(async ({ question }: { question: string }) => `result for ${question}`, {
  name: 'search_web_tool',
  description: 'fake search tool',
  schema: z.object({ question: z.string() }),
});

/**
 * 7 轮相同的 tool_call 响应：第 5 轮触发首次硬停，第 6 轮触发终止硬停。
 * 注意每轮 id 必须唯一——路由器按 tool_call_id 对历史 ToolMessage 去重计算
 * pending，真实模型每轮生成新 id；复用同一 id 会让 pending 恒为 0 提前收场。
 */
const sameCall = (round: number) => ({
  id: `call-same-${round}`,
  name: 'search_web_tool',
  args: { question: 'same question' },
});
const sevenSameCalls = Array.from({ length: 7 }, (_, i) => [sameCall(i)]);

const reset = (loopDetectionMiddleware as unknown as { reset: (threadId?: string) => void }).reset;

describe('硬停 jumpTo（真实 graph）', () => {
  beforeEach(() => {
    reset();
  });

  it('首次硬停跳回模型再生成一轮；模型继续调工具则第二次硬停终止图形', async () => {
    const indexRef = { current: 0 };
    const model = new FakeToolCallingModel({ toolCalls: sevenSameCalls, indexRef });
    const agent = createAgent({
      model,
      tools: [fakeSearch],
      middleware: [loopDetectionMiddleware],
    });

    const result = await agent.invoke(
      { messages: [{ role: 'user', content: 'research this' }] },
      { configurable: { thread_id: 't-integration-hardstop' } },
    );

    // 5 轮普通调用 + 跳回后的 1 轮生成 = 6 次模型调用。
    // 若跳回未生效（硬停后直接 END），模型只会被调 5 次。
    expect(indexRef.current).toBe(6);

    const messages = result.messages as Array<{
      content?: unknown;
      tool_calls?: unknown;
      name?: string;
    }>;
    const last = messages.at(-1)!;

    // 终止形态：最后一条是无 tool_calls 的 AIMessage，收尾文案并入其中
    expect(last.tool_calls ?? []).toHaveLength(0);
    expect(String(last.content)).toContain('FORCED STOP');
    expect(HumanMessage.isInstance(last)).toBe(false);
    expect(AIMessage.isInstance(last)).toBe(true);

    // 历史里留有首次硬停注入的收尾指令（证明走了跳回分支而非直接终止）
    const hasInstruction = messages.some(
      (m) => HumanMessage.isInstance(m) && (m as HumanMessage).name === 'loop_hard_stop',
    );
    expect(hasInstruction).toBe(true);
  }, 30_000);
});
