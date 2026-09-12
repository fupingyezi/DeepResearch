import { ToolMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runWithContext, type RuntimeContext } from '../../runtime/context';
import { setThreadImageFetcher } from '../../vision';
import { viewImageTool } from './view-image-tool';

const ONE_PX_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/**
 * 用公开的 invoke 走完整工具调用路径，config 里带 state / toolCallId ——
 * 生产路径下这两项由 ToolNode 注入（见 ToolNode.runTool 的 `tool.invoke(toolCall, {...})`）。
 */
async function callTool(
  input: { description: string; filename: string },
  runtime: { state?: unknown; toolCallId?: string },
): Promise<unknown> {
  // state / toolCallId 由 ToolNode 在 config 上额外注入，公开的 invoke 配置类型
  // 只声明 RunnableConfig 部分 —— 单层断言，与生产代码读 runtime.state 同一外部边界。
  const config = {
    state: runtime.state,
    toolCallId: runtime.toolCallId,
  } as unknown as Parameters<typeof viewImageTool.invoke>[1];
  return viewImageTool.invoke(input, config);
}

/** 在指定模型能力下执行（view_image 用 ALS 里的 currentModelConfig 做视觉能力防御）。 */
function withModel<T>(supportsVision: boolean, fn: () => Promise<T>): Promise<T> {
  const ctx: RuntimeContext = {
    thread_id: 't-1',
    run_id: 'r-1',
    assistant_id: 'lead',
    currentModelConfig: { modelName: 'glm-5.3-flash', supportsVision },
  };
  return runWithContext(ctx, fn);
}

const IMAGE_STATE = {
  uploadedFiles: [
    { fileId: 'f-1', filename: 'cat.png', mimeType: 'image/png', minioKey: 'files/1' },
    { fileId: 'f-2', filename: 'notes.txt', mimeType: 'text/plain', minioKey: 'files/2' },
  ],
};

describe('view_image 工具', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    setThreadImageFetcher(null);
    vi.restoreAllMocks();
  });

  it('非视觉模型直接拒绝（不能给 provider 发 image blocks）', async () => {
    setThreadImageFetcher(async () => ({ base64: ONE_PX_PNG, mimeType: 'image/png' }));

    const out = await withModel(false, () =>
      callTool({ description: '看看', filename: 'cat.png' }, { state: IMAGE_STATE }),
    );

    expect(typeof out).toBe('string');
    expect(out).toContain('不支持图片理解');
  });

  it('本会话无图片时给出说明', async () => {
    const out = await withModel(true, () =>
      callTool({ description: '看看', filename: 'cat.png' }, { state: { uploadedFiles: [] } }),
    );
    expect(out).toBe('本会话没有可用图片。');
  });

  it('文件名未命中时列出可用图片（只列图片，不列文档）', async () => {
    const out = (await withModel(true, () =>
      callTool({ description: '看看', filename: 'dog.png' }, { state: IMAGE_STATE }),
    )) as string;

    expect(out).toContain('未找到图片 "dog.png"');
    expect(out).toContain('cat.png');
    expect(out).not.toContain('notes.txt');
  });

  it('fetcher 未注册时给出说明而非抛错', async () => {
    setThreadImageFetcher(null);
    const out = (await withModel(true, () =>
      callTool({ description: '看看', filename: 'cat.png' }, { state: IMAGE_STATE }),
    )) as string;
    expect(out).toContain('读取通道未就绪');
  });

  it('happy path：返回带 image_url 的多模态 ToolMessage，且自带 tool_call_id', async () => {
    setThreadImageFetcher(async () => ({ base64: ONE_PX_PNG, mimeType: 'image/png' }));

    const out = await withModel(true, () =>
      callTool(
        { description: '重新仔细看这张图', filename: 'cat.png' },
        { state: IMAGE_STATE, toolCallId: 'call-42' },
      ),
    );

    expect(out).toBeInstanceOf(ToolMessage);
    const msg = out as ToolMessage;
    // ToolNode 对 ToolMessage 实例原样采用，不会补 tool_call_id —— 必须自带
    expect(msg.tool_call_id).toBe('call-42');
    expect(msg.name).toBe('view_image');
    const blocks = msg.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({ type: 'text' });
    expect(String(blocks[0].text)).toContain('重新仔细看这张图');
    expect(blocks[1].type).toBe('image_url');
    expect(JSON.stringify(blocks[1])).toContain('data:image/png;base64,');
  });

  it('同名图片取最新一张', async () => {
    const seen: string[] = [];
    setThreadImageFetcher(async (ref) => {
      seen.push(ref.fileId);
      return { base64: ONE_PX_PNG, mimeType: 'image/png' };
    });

    await withModel(true, () =>
      callTool(
        { description: 'x', filename: 'cat.png' },
        {
          state: {
            uploadedFiles: [
              { fileId: 'old', filename: 'cat.png', mimeType: 'image/png', minioKey: 'k1' },
              { fileId: 'new', filename: 'cat.png', mimeType: 'image/png', minioKey: 'k2' },
            ],
          },
          toolCallId: 'c',
        },
      ),
    );

    expect(seen).toEqual(['new']);
  });

  it('超过大小上限时返回文本而非抛错', async () => {
    setThreadImageFetcher(async () => ({
      base64: 'A'.repeat(8 * 1024 * 1024), // 解码后约 6MB > 默认 5MB
      mimeType: 'image/png',
    }));

    const out = (await withModel(true, () =>
      callTool({ description: 'x', filename: 'cat.png' }, { state: IMAGE_STATE }),
    )) as string;

    expect(typeof out).toBe('string');
    expect(out).toContain('超过大小上限');
  });

  it('读取失败（fetcher 返回 null）时返回文本说明', async () => {
    setThreadImageFetcher(async () => null);

    const out = (await withModel(true, () =>
      callTool({ description: 'x', filename: 'cat.png' }, { state: IMAGE_STATE }),
    )) as string;

    expect(out).toContain('读取失败');
  });
});
