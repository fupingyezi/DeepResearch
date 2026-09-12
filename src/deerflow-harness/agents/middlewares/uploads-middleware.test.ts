import { SystemMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UploadedFile } from '../thread-state';

const loadSessionUploadedFiles = vi.fn<(threadId: string) => Promise<UploadedFile[]>>();
vi.mock('./thread-data-middleware', () => ({
  loadSessionUploadedFiles: (threadId: string) => loadSessionUploadedFiles(threadId),
}));

const getContext = vi.fn<() => { thread_id: string } | undefined>();
vi.mock('../../runtime/context', () => ({
  getContext: () => getContext(),
}));

const { uploadsMiddleware } = await import('./uploads-middleware');

const PNG_FILE: UploadedFile = {
  fileId: 'f-1',
  filename: 'ocr-test.png',
  mimeType: 'image/png',
  sizeBytes: 2933383,
  minioKey: 'files/f-1/shot.png',
  content: '模型体验\nGLM-4-Plus\nGLM-Z1-Air',
};

async function run(state: unknown) {
  return (
    uploadsMiddleware as unknown as {
      beforeAgent: (s: unknown) => Promise<{ messages?: unknown[] } | undefined>;
    }
  ).beforeAgent(state);
}

describe('UploadsMiddleware', () => {
  beforeEach(() => {
    loadSessionUploadedFiles.mockReset();
    getContext.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('state 无文件时自行按 thread_id 取数并注入（跨中间件 state 读不到的兜底）', async () => {
    // 这正是实测场景：ThreadDataMiddleware 写了 state.uploadedFiles，
    // 但 LangChain v1 的节点输入限制使下游读到 undefined
    getContext.mockReturnValue({ thread_id: 't-1' });
    loadSessionUploadedFiles.mockResolvedValue([PNG_FILE]);

    const out = await run({ messages: [], uploadedFiles: undefined });

    expect(loadSessionUploadedFiles).toHaveBeenCalledWith('t-1');
    expect(out?.messages).toHaveLength(1);
    const injected = (out!.messages as SystemMessage[])[0];
    expect(injected).toBeInstanceOf(SystemMessage);
    const text = String(injected.content);
    expect(text).toContain('<!-- uploads-context -->');
    expect(text).toContain('ocr-test.png');
    // OCR 正文必须进 prompt（这是图片解析的最终价值）
    expect(text).toContain('GLM-4-Plus');
  });

  it('state 已有文件时不查库（走快路径）', async () => {
    getContext.mockReturnValue({ thread_id: 't-1' });

    const out = await run({ messages: [], uploadedFiles: [PNG_FILE] });

    expect(loadSessionUploadedFiles).not.toHaveBeenCalled();
    expect(out?.messages).toHaveLength(1);
  });

  it('messages 已含特征 tag 时跳过注入（防同一 run 重复追加）', async () => {
    getContext.mockReturnValue({ thread_id: 't-1' });
    const existing = new SystemMessage('<!-- uploads-context -->\n## 用户上传的文件');

    const out = await run({ messages: [existing], uploadedFiles: [PNG_FILE] });

    expect(out).toBeUndefined();
  });

  it('确实没有文件时不注入', async () => {
    getContext.mockReturnValue({ thread_id: 't-1' });
    loadSessionUploadedFiles.mockResolvedValue([]);

    expect(await run({ messages: [], uploadedFiles: [] })).toBeUndefined();
  });

  it('无 thread_id 且 state 为空时不注入，不抛错', async () => {
    getContext.mockReturnValue(undefined);
    expect(await run({ messages: [], uploadedFiles: null })).toBeUndefined();
  });

  it('content 为 null 时仍注入元信息（图片未解析出文字的降级形态）', async () => {
    getContext.mockReturnValue({ thread_id: 't-1' });
    loadSessionUploadedFiles.mockResolvedValue([{ ...PNG_FILE, content: null }]);

    const out = await run({ messages: [], uploadedFiles: undefined });

    const text = String((out!.messages as SystemMessage[])[0].content);
    expect(text).toContain('ocr-test.png');
    expect(text).toContain('无解析内容');
  });

  it('取数抛错时静默降级，不影响主流程', async () => {
    getContext.mockReturnValue({ thread_id: 't-1' });
    loadSessionUploadedFiles.mockRejectedValue(new Error('db down'));

    expect(await run({ messages: [], uploadedFiles: undefined })).toBeUndefined();
  });
});
