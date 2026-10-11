import { describe, it, expect, beforeEach } from 'vitest';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';

import { loopDetectionMiddleware } from '../loop-detection-middleware';

/**
 * 硬停行为测试：直接调用 afterModel hook（对象形态 { hook, canJumpTo }）。
 *
 * 核心不变量（来自线上事故）：硬停若直接 END，run 会以「只有工具活动、
 * 没有回答」的面目收场——中间件对 state 的改写不产生 SSE 事件，前端
 * 看不到任何最终答案。首次硬停必须跳回模型（用户面 'model'，路由映射到
 * model_request）再走一轮模型生成；模型继续无视时才终止，防无限循环。
 */

type HookResult = { messages: BaseMessage[]; jumpTo?: string } | undefined;

function callHook(state: { messages: BaseMessage[] }, threadId: string): Promise<HookResult> {
  const hook = (
    loopDetectionMiddleware.afterModel as {
      hook: (state: any, runtime: any) => Promise<HookResult>;
    }
  ).hook;
  return hook(state, { configurable: { thread_id: threadId } });
}

function searchCall(question: string): AIMessage {
  return new AIMessage({
    content: '',
    tool_calls: [
      {
        id: `c-${question}`,
        name: 'search_web_tool',
        args: { question },
        type: 'tool_call' as const,
      },
    ],
  });
}

const reset = (loopDetectionMiddleware as unknown as { reset: (threadId?: string) => void }).reset;

beforeEach(() => {
  reset();
});

describe('afterModel 硬停（jumpTo model）', () => {
  it('canJumpTo 声明包含 model', () => {
    const afterModel = loopDetectionMiddleware.afterModel as { canJumpTo?: string[] };
    expect(afterModel.canJumpTo).toContain('model');
  });

  it('无工具调用的消息直接放行', async () => {
    const result = await callHook(
      { messages: [new AIMessage({ content: 'final answer' })] },
      't-noop',
    );
    expect(result).toBeUndefined();
  });

  it('相同工具调用第 5 轮触发首次硬停：剥离 tool_calls + 注入收尾指令 + 跳回模型', async () => {
    const threadId = 't-hardstop-first';
    let result: HookResult = undefined;
    for (let i = 0; i < 5; i++) {
      result = await callHook({ messages: [searchCall('same question')] }, threadId);
    }

    expect(result).toBeDefined();
    expect(result!.jumpTo).toBe('model');
    expect(result!.messages).toHaveLength(2);

    const [stripped, instruction] = result!.messages;
    expect(AIMessage.isInstance(stripped)).toBe(true);
    expect((stripped as AIMessage).tool_calls).toHaveLength(0);
    expect((stripped as AIMessage).content).toBe(''); // 原内容保留，收尾指令走 HumanMessage

    expect(HumanMessage.isInstance(instruction)).toBe(true);
    expect((instruction as HumanMessage).name).toBe('loop_hard_stop');
    expect(String((instruction as HumanMessage).content)).toContain('FORCED STOP');
  });

  it('模型继续调工具触发第二次硬停：终止图形，收尾文案并入最后一条 AI 消息', async () => {
    const threadId = 't-hardstop-terminal';
    for (let i = 0; i < 5; i++) {
      await callHook({ messages: [searchCall('same question')] }, threadId);
    }
    const result = await callHook({ messages: [searchCall('same question')] }, threadId);

    expect(result).toBeDefined();
    expect(result!.jumpTo).toBeUndefined();
    expect(result!.messages).toHaveLength(1);
    expect(HumanMessage.isInstance(result!.messages[0])).toBe(false);
    expect(AIMessage.isInstance(result!.messages[0])).toBe(true);
    expect(String((result!.messages[0] as AIMessage).content)).toContain('FORCED STOP');
    expect((result!.messages[0] as AIMessage).tool_calls).toHaveLength(0);
  });

  it('第 3 轮同调用触发警告：注入 loop_warning，不跳转', async () => {
    const threadId = 't-warning';
    let result: HookResult = undefined;
    for (let i = 0; i < 3; i++) {
      result = await callHook({ messages: [searchCall('warn question')] }, threadId);
    }

    expect(result).toBeDefined();
    expect(result!.jumpTo).toBeUndefined();
    expect(result!.messages).toHaveLength(1);
    const warning = result!.messages[0];
    expect(HumanMessage.isInstance(warning)).toBe(true);
    expect((warning as HumanMessage).name).toBe('loop_warning');
    expect(String((warning as HumanMessage).content)).toContain('LOOP DETECTED');
  });

  it('频次层：同一工具不同参数刷到 50 次触发硬停并跳回模型', async () => {
    const threadId = 't-freq-hardstop';
    let result: HookResult = undefined;
    for (let i = 0; i < 50; i++) {
      result = await callHook({ messages: [searchCall(`distinct question ${i}`)] }, threadId);
    }

    expect(result).toBeDefined();
    expect(result!.jumpTo).toBe('model');
    const instruction = result!.messages[1];
    expect(HumanMessage.isInstance(instruction)).toBe(true);
    expect(String((instruction as HumanMessage).content)).toContain('called 50 times');
  });

  it('线程间计数隔离：A 线程硬停不影响 B 线程', async () => {
    for (let i = 0; i < 4; i++) {
      await callHook({ messages: [searchCall('same question')] }, 't-isolate-a');
    }
    // B 线程同样的调用刚进入第 4 轮，不应触发硬停（A 的计数无关）
    const result = await callHook({ messages: [searchCall('same question')] }, 't-isolate-b');
    expect(result).toBeUndefined();
  });
});
