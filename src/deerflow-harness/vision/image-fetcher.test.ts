import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildHumanMessageContent,
  setThreadImageFetcher,
  type FetchedImage,
  type ThreadImageRef,
} from './image-fetcher';

/** 记录调用参数的假 fetcher。 */
function fakeFetcher(
  behavior: (ref: ThreadImageRef) => Promise<FetchedImage | null>,
  calls: ThreadImageRef[],
) {
  return async (ref: ThreadImageRef): Promise<FetchedImage | null> => {
    calls.push(ref);
    return behavior(ref);
  };
}

const REF_A: ThreadImageRef = {
  fileId: 'f-a',
  filename: 'a.png',
  mimeType: 'image/png',
  minioKey: 'files/a',
};

const REF_B: ThreadImageRef = {
  fileId: 'f-b',
  filename: 'b.png',
  mimeType: 'image/png',
  minioKey: 'files/b',
};

const ONE_PX_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const OPTS = { supportsVision: true, maxImageBytes: 5 * 1024 * 1024 };

describe('buildHumanMessageContent', () => {
  let calls: ThreadImageRef[];

  beforeEach(() => {
    calls = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    setThreadImageFetcher(null);
    vi.restoreAllMocks();
  });

  it('模型不支持视觉时退回 string，且不调用 fetcher', async () => {
    setThreadImageFetcher(
      fakeFetcher(async () => ({ base64: ONE_PX_PNG, mimeType: 'image/png' }), calls),
    );

    const r = await buildHumanMessageContent('你好', [REF_A], {
      supportsVision: false,
      maxImageBytes: OPTS.maxImageBytes,
    });

    expect(r.content).toBe('你好');
    expect(r.attached).toBe(0);
    expect(r.degraded).toEqual(['a.png']);
    expect(calls).toHaveLength(0);
  });

  it('无图片时原样返回 string，degraded 为空', async () => {
    const r = await buildHumanMessageContent('你好', [], OPTS);
    expect(r.content).toBe('你好');
    expect(r.attached).toBe(0);
    expect(r.degraded).toEqual([]);
  });

  it('fetcher 未注册时退回 string 且不抛错', async () => {
    setThreadImageFetcher(null);
    const r = await buildHumanMessageContent('你好', [REF_A], OPTS);
    expect(r.content).toBe('你好');
    expect(r.attached).toBe(0);
    expect(r.degraded).toEqual(['a.png']);
  });

  it('happy path：文本块在前、[附图:] 标签随行、image_url 用 data URL', async () => {
    setThreadImageFetcher(
      fakeFetcher(async () => ({ base64: ONE_PX_PNG, mimeType: 'image/png' }), calls),
    );

    const r = await buildHumanMessageContent('看看这张图', [REF_A], OPTS);

    expect(Array.isArray(r.content)).toBe(true);
    const blocks = r.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: 'text', text: '看看这张图' });
    // 文件名标签必须先于 image block，且是可被模型读到的纯文本
    expect(blocks[1]).toEqual({ type: 'text', text: '[附图: a.png]' });
    expect(blocks[2].type).toBe('image_url');
    expect((blocks[2].image_url as { url: string }).url).toBe(
      `data:image/png;base64,${ONE_PX_PNG}`,
    );
    expect(r.attached).toBe(1);
    expect(r.degraded).toEqual([]);
  });

  it('sizeBytes 超限时直接跳过，不调用 fetcher', async () => {
    setThreadImageFetcher(
      fakeFetcher(async () => ({ base64: ONE_PX_PNG, mimeType: 'image/png' }), calls),
    );

    const r = await buildHumanMessageContent('x', [{ ...REF_A, sizeBytes: 999 }], {
      supportsVision: true,
      maxImageBytes: 100,
    });

    expect(typeof r.content).toBe('string');
    expect(r.content).toContain('超过大小上限');
    expect(r.attached).toBe(0);
    expect(r.degraded).toEqual(['a.png']);
    expect(calls).toHaveLength(0);
  });

  it('fetcher 抛出异常时降级为文本说明，不向上抛', async () => {
    setThreadImageFetcher(
      fakeFetcher(async () => {
        throw new Error('minio down');
      }, calls),
    );

    const r = await buildHumanMessageContent('x', [REF_A], OPTS);

    expect(typeof r.content).toBe('string');
    expect(r.content).toContain('无法加载');
    expect(r.attached).toBe(0);
    expect(r.degraded).toEqual(['a.png']);
  });

  it('部分成功：成功的进 blocks，失败的进 degraded 并在文本里附注', async () => {
    setThreadImageFetcher(
      fakeFetcher(async (ref) => {
        if (ref.fileId === 'f-b') return null; // 模拟读取失败
        return { base64: ONE_PX_PNG, mimeType: 'image/png' };
      }, calls),
    );

    const r = await buildHumanMessageContent('两张图', [REF_A, REF_B], OPTS);

    const blocks = r.content as Array<Record<string, unknown>>;
    expect(blocks.filter((b) => b.type === 'image_url')).toHaveLength(1);
    expect(r.attached).toBe(1);
    expect(r.degraded).toEqual(['b.png']);
    // 降级说明并入首个文本块
    expect(String(blocks[0].text)).toContain('无法加载');
  });
});
