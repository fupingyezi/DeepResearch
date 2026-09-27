import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildParentContextBlock,
  PARENT_CONTEXT_MAX_CHARS,
  PARENT_CONTEXT_PER_MESSAGE_CHARS,
  readParentHistoryBlock,
  setParentHistoryProvider,
} from '../parent-history';

beforeEach(() => setParentHistoryProvider(null));
afterEach(() => setParentHistoryProvider(null));

describe('buildParentContextBlock —— 父历史剪枝纯函数', () => {
  it('空输入 / 非数组 → 空串', () => {
    expect(buildParentContextBlock([])).toBe('');
    expect(buildParentContextBlock(undefined as unknown as unknown[])).toBe('');
  });

  it('多模态 content 只取文本块，base64 不进上下文', () => {
    const messages = [
      new HumanMessage({
        content: [
          { type: 'text', text: '看这张图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      }),
    ];
    const block = buildParentContextBlock(messages);
    expect(block).toContain('看这张图');
    expect(block).not.toContain('base64');
    expect(block).not.toContain('image_url');
  });

  it('剥离 uploads 注入块', () => {
    const messages = [
      new HumanMessage({
        content: '背景问题\n<uploaded_files>\n报告.pdf：全文解析内容……\n</uploaded_files>\n请分析',
      }),
    ];
    const block = buildParentContextBlock(messages);
    expect(block).toContain('请分析');
    expect(block).not.toContain('uploaded_files');
    expect(block).not.toContain('报告.pdf');
  });

  it('跳过 system 消息与纯 tool_call 的 AI 消息（task 调用本身不注入）', () => {
    const messages = [
      new SystemMessage('子 agent 有自己的 systemPrompt，这段不应出现'),
      new HumanMessage('研究量子计算'),
      new AIMessage({ content: '', tool_calls: [{ id: 't1', name: 'task', args: {} }] }),
    ];
    const block = buildParentContextBlock(messages);
    expect(block).toContain('研究量子计算');
    expect(block).not.toContain('这段不应出现');
    expect(block).not.toContain('[assistant]');
  });

  it('AI 正文与 tool result（带工具名）按角色标注，时间序旧→新', () => {
    const messages = [
      new HumanMessage('先查 A'),
      new AIMessage('A 的结论是 X'),
      new ToolMessage({ content: '搜索结果……', tool_call_id: 't1', name: 'search_web_tool' }),
      new HumanMessage('再查 B'),
    ];
    const block = buildParentContextBlock(messages);
    expect(block).toContain('[user]\n先查 A');
    expect(block).toContain('[assistant]\nA 的结论是 X');
    expect(block).toContain('[tool result: search_web_tool]');
    expect(block.indexOf('先查 A')).toBeLessThan(block.indexOf('再查 B'));
  });

  it('超长消息从头截断并加标记', () => {
    const long = '长'.repeat(PARENT_CONTEXT_PER_MESSAGE_CHARS + 500);
    const block = buildParentContextBlock([new HumanMessage(long)]);
    expect(block).toContain('…[截断]');
    expect(block).not.toContain('长'.repeat(PARENT_CONTEXT_PER_MESSAGE_CHARS + 100));
  });

  it('总预算封顶：保留最近消息、丢弃更早历史', () => {
    const filler = '中'.repeat(300);
    const messages = Array.from({ length: 30 }, (_, i) => new HumanMessage(`第${i}条 ${filler}`));
    const block = buildParentContextBlock(messages);
    expect(block).toContain('[parent conversation context]');
    expect(block).toContain('第29条');
    expect(block).not.toContain('第0条');
    expect(block.length).toBeLessThanOrEqual(PARENT_CONTEXT_MAX_CHARS + 64); // 头部与换行余量
  });
});

describe('readParentHistoryBlock —— provider 读取与静默降级', () => {
  it('provider 未注册 → undefined', async () => {
    expect(await readParentHistoryBlock('thread-1')).toBeUndefined();
  });

  it('provider 返回 undefined / 非数组 → undefined', async () => {
    setParentHistoryProvider(async () => undefined);
    expect(await readParentHistoryBlock('thread-1')).toBeUndefined();
    setParentHistoryProvider(async () => 'not-an-array' as unknown as unknown[]);
    expect(await readParentHistoryBlock('thread-1')).toBeUndefined();
  });

  it('provider 抛错 → undefined 且告警一次', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setParentHistoryProvider(async () => {
      throw new Error('pg down');
    });
    expect(await readParentHistoryBlock('thread-1')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(await readParentHistoryBlock('thread-1')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1); // 只报一次，避免每次 task 刷屏
    warnSpy.mockRestore();
  });

  it('正常读取 → 剪枝后的上下文块', async () => {
    setParentHistoryProvider(async (threadId) => {
      expect(threadId).toBe('thread-1');
      return [new HumanMessage('用户背景'), new AIMessage('上一轮结论')];
    });
    const block = await readParentHistoryBlock('thread-1');
    expect(block).toContain('[parent conversation context]');
    expect(block).toContain('用户背景');
    expect(block).toContain('上一轮结论');
  });
});
