import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { contentHasImageBlocks, visionMiddleware } from './vision-middleware';

const IMAGE_URL = 'data:image/png;base64,AAAA';

function humanWithImage(text: string, id?: string, file = 'cat.png') {
  return new HumanMessage({
    content: [
      { type: 'text', text },
      { type: 'text', text: `[附图: ${file}]` },
      { type: 'image_url', image_url: { url: IMAGE_URL } },
    ],
    ...(id ? { id } : {}),
  });
}

function toolWithImage(id: string, toolCallId: string) {
  return new ToolMessage({
    content: [
      { type: 'text', text: '已加载图片: cat.png' },
      { type: 'image_url', image_url: { url: IMAGE_URL } },
    ],
    id,
    tool_call_id: toolCallId,
    name: 'view_image',
  });
}

async function run(state: unknown) {
  return (
    visionMiddleware as unknown as {
      beforeAgent: (s: unknown) => Promise<{ messages?: unknown[] } | undefined>;
    }
  ).beforeAgent(state);
}

describe('contentHasImageBlocks', () => {
  it('string → false', () => {
    expect(contentHasImageBlocks('纯文本')).toBe(false);
  });

  it('纯文本数组 → false', () => {
    expect(contentHasImageBlocks([{ type: 'text', text: 'a' }])).toBe(false);
  });

  it('null → false', () => {
    expect(contentHasImageBlocks(null)).toBe(false);
  });

  it('含 image_url → true', () => {
    expect(contentHasImageBlocks([{ type: 'image_url', image_url: { url: IMAGE_URL } }])).toBe(
      true,
    );
  });
});

describe('visionMiddleware.beforeAgent（历史图片压缩）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('保留最后一条含图 HumanMessage（本轮新输入），压缩更早的图', async () => {
    const older = humanWithImage('上一轮', 'h-1', 'old.png');
    const latest = humanWithImage('本轮', 'h-2', 'new.png');

    const out = await run({ messages: [older, latest] });

    expect(out?.messages).toBeDefined();
    const [m1, m2] = out!.messages as HumanMessage[];
    // 历史图被压成占位文本
    expect(JSON.stringify(m1.content)).toContain('[图片已查看');
    expect(JSON.stringify(m1.content)).not.toContain('base64');
    // 本轮图保持原样（模型需要看）
    expect(JSON.stringify(m2.content)).toContain('base64');
  });

  it('压缩时保留消息 id（add_messages 按 id merge，否则会重复追加）', async () => {
    const older = humanWithImage('上一轮', 'h-1');

    const out = await run({ messages: [older, humanWithImage('本轮', 'h-2')] });

    const [m1] = out!.messages as HumanMessage[];
    expect(m1.id).toBe('h-1');
  });

  it('ToolMessage 的图也被压缩，且 tool_call_id / name 保留', async () => {
    const tool = toolWithImage('t-1', 'call-1');

    const out = await run({ messages: [tool, humanWithImage('本轮', 'h-2')] });

    const [m1] = out!.messages as ToolMessage[];
    expect(JSON.stringify(m1.content)).toContain('[图片已查看');
    expect(m1.tool_call_id).toBe('call-1');
    expect(m1.name).toBe('view_image');
  });

  it('无 id 的消息跳过（append 语义会重复），有 id 的正常压缩', async () => {
    const noId = humanWithImage('更早的无 id 消息');
    const withId = humanWithImage('上一轮', 'h-1');

    const out = await run({ messages: [noId, withId, humanWithImage('本轮', 'h-2')] });

    const msgs = out!.messages as HumanMessage[];
    // 无 id：跳过替换（改了会因 add_messages 的 append 语义而重复）
    expect(JSON.stringify(msgs[0].content)).toContain('base64');
    expect(msgs[0]).toBe(noId);
    // 有 id：正常压成占位
    expect(JSON.stringify(msgs[1].content)).toContain('[图片已查看');
  });

  it('仅有无 id 的可压缩消息时整体无变化 → undefined', async () => {
    const noId = humanWithImage('更早的无 id 消息');
    const out = await run({ messages: [noId, humanWithImage('本轮', 'h-2')] });
    expect(out).toBeUndefined();
  });

  it('无图可压时返回 undefined（不产生冗余 state 写入）', async () => {
    const out = await run({ messages: [new HumanMessage({ content: '纯文本', id: 'h-1' })] });
    expect(out).toBeUndefined();
  });

  it('不就地修改原消息数组（同一轮重放安全）', async () => {
    const older = humanWithImage('上一轮', 'h-1');
    const latest = humanWithImage('本轮', 'h-2');
    const messages = [older, latest];
    const before = JSON.stringify(messages.map((m) => m.content));

    await run({ messages });

    expect(JSON.stringify(messages.map((m) => m.content))).toBe(before);
    expect(messages[0]).toBe(older);
  });

  it('异常输入不抛，返回 undefined', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run(undefined)).toBeUndefined();
    expect(await run({ messages: 'not-an-array' })).toBeUndefined();
  });
});

/**
 * 顺序不变量：压缩必须发生在「模型进入循环」之前，否则摘要器会把未压缩的
 * base64 `JSON.stringify` 进摘要 prompt 的纯文本（数 MB 文本灌进一次请求）。
 * 该保证来自 LangGraph 结构（BeforeAgentNode 先于 BeforeModelNode），
 * 因此断言的是两个 hook 的**种类**而非链上位序。
 */
describe('顺序不变量：压缩先于摘要', () => {
  it('VisionMiddleware 只挂 beforeAgent（agent 入口，先于模型循环）', () => {
    expect(typeof (visionMiddleware as { beforeAgent?: unknown }).beforeAgent).toBe('function');
    expect((visionMiddleware as { beforeModel?: unknown }).beforeModel).toBeUndefined();
  });

  it('LangChain summarizationMiddleware 挂在 beforeModel', async () => {
    const { summarizationMiddleware: lcSummarization } = await import('langchain');
    const instance = lcSummarization({
      model: {} as never,
      trigger: { tokens: 1000 },
      keep: { messages: 2 },
    }) as { beforeModel?: unknown; beforeAgent?: unknown };
    expect(typeof instance.beforeModel).toBe('function');
    expect(instance.beforeAgent).toBeUndefined();
  });
});
