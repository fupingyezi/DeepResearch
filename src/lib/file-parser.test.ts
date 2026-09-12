import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ocrImageFromZhipu } from './file-parser';

const PNG = Buffer.from('fake-png-bytes');
const MIME = 'image/png';
const NAME = 'shot.png';

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
}

/** 安装假 fetch：按 URL 结尾分派响应。 */
function stubFetch(handlers: {
  layoutParsing?: (call: FetchCall) => Response | Promise<Response>;
  chatCompletions?: (call: FetchCall) => Response | Promise<Response>;
}): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const call = { url: String(url), body };
    calls.push(call);
    if (String(url).endsWith('/layout_parsing')) {
      if (!handlers.layoutParsing) throw new Error('unexpected layout_parsing call');
      return handlers.layoutParsing(call);
    }
    if (String(url).endsWith('/chat/completions')) {
      if (!handlers.chatCompletions) throw new Error('unexpected chat/completions call');
      return handlers.chatCompletions(call);
    }
    throw new Error(`unexpected url: ${url}`);
  });
  return calls;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ocrImageFromZhipu', () => {
  const originalKey = process.env.ZHIPU_API_KEY;
  const originalBase = process.env.ZHIPU_BASE_URL;
  const originalModel = process.env.ZHIPU_OCR_MODEL;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.ZHIPU_BASE_URL;
    delete process.env.ZHIPU_OCR_MODEL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalKey === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.ZHIPU_BASE_URL;
    else process.env.ZHIPU_BASE_URL = originalBase;
    if (originalModel === undefined) delete process.env.ZHIPU_OCR_MODEL;
    else process.env.ZHIPU_OCR_MODEL = originalModel;
  });

  it('无 ZHIPU_API_KEY 时返回占位文本，且不发起任何请求', async () => {
    delete process.env.ZHIPU_API_KEY;
    const calls = stubFetch({});

    const out = await ocrImageFromZhipu(PNG, MIME, NAME);

    expect(out).toContain('未能提取文字');
    expect(out).toContain('未配置 ZHIPU_API_KEY');
    expect(calls).toHaveLength(0);
  });

  it('超过 10MB 时返回占位文本，且不发起任何请求', async () => {
    process.env.ZHIPU_API_KEY = 'k';
    const calls = stubFetch({});
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1);

    const out = await ocrImageFromZhipu(huge, MIME, NAME);

    expect(out).toContain('超过单图 10MB 上限');
    expect(calls).toHaveLength(0);
  });

  it('主路径成功：取 md_results，且 markdown 换行不被压平', async () => {
    process.env.ZHIPU_API_KEY = 'k';
    const calls = stubFetch({
      layoutParsing: () => jsonResponse(200, { md_results: '# 标题\n\n| a | b |\n| - | - |\n' }),
    });

    const out = await ocrImageFromZhipu(PNG, MIME, NAME);

    expect(out).toBe('# 标题\n\n| a | b |\n| - | - |');
    // 换行与表格结构必须保留（若走 extractTextFromFile 的空白折叠就废了）
    expect(out).toContain('\n');
    // 请求形态：data URI（裸 base64 会被智谱拒） + 默认模型 glm-ocr
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/layout_parsing$/);
    expect(String(calls[0].body.file)).toMatch(/^data:image\/png;base64,/);
    expect(calls[0].body.model).toBe('glm-ocr');
  });

  it('image/jpg 归一为 image/jpeg（非标准 MIME 名会被端点拒）', async () => {
    process.env.ZHIPU_API_KEY = 'k';
    const calls = stubFetch({
      layoutParsing: () => jsonResponse(200, { md_results: 'x' }),
    });

    await ocrImageFromZhipu(PNG, 'image/jpg', 'a.jpg');

    expect(String(calls[0].body.file)).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('ZHIPU_OCR_MODEL / ZHIPU_BASE_URL 可覆盖默认值', async () => {
    process.env.ZHIPU_API_KEY = 'k';
    process.env.ZHIPU_OCR_MODEL = 'glm-ocr-custom';
    process.env.ZHIPU_BASE_URL = 'https://example.test/v1/';
    const calls = stubFetch({
      layoutParsing: () => jsonResponse(200, { md_results: 'x' }),
    });

    await ocrImageFromZhipu(PNG, MIME, NAME);

    expect(calls[0].url).toBe('https://example.test/v1/layout_parsing');
    expect(calls[0].body.model).toBe('glm-ocr-custom');
  });

  it('layout_parsing 非 2xx → 降级到视觉模型', async () => {
    process.env.ZHIPU_API_KEY = 'k';
    const calls = stubFetch({
      layoutParsing: () => jsonResponse(400, { error: { code: '1214' } }),
      chatCompletions: () =>
        jsonResponse(200, { choices: [{ message: { content: '图中有三行文字' } }] }),
    });

    const out = await ocrImageFromZhipu(PNG, MIME, NAME);

    expect(out).toBe('图中有三行文字');
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toMatch(/\/chat\/completions$/);
    // 降级请求同样走 data URI
    const content = calls[1].body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const imageBlock = content[0].content.find((b) => b.type === 'image_url');
    expect(JSON.stringify(imageBlock)).toContain('data:image/png;base64,');
  });

  it('layout_parsing 返回空 md_results → 降级到视觉模型', async () => {
    process.env.ZHIPU_API_KEY = 'k';
    const calls = stubFetch({
      layoutParsing: () => jsonResponse(200, { md_results: '   ' }),
      chatCompletions: () => jsonResponse(200, { choices: [{ message: { content: '兜底结果' } }] }),
    });

    expect(await ocrImageFromZhipu(PNG, MIME, NAME)).toBe('兜底结果');
    expect(calls).toHaveLength(2);
  });

  it('两条路径都失败 → 占位文本，不抛错', async () => {
    process.env.ZHIPU_API_KEY = 'k';
    stubFetch({
      layoutParsing: () => jsonResponse(500, {}),
      chatCompletions: () => jsonResponse(500, {}),
    });

    const out = await ocrImageFromZhipu(PNG, MIME, NAME);

    expect(out).toContain('未能提取文字');
    expect(out).toContain('OCR 与视觉模型均未返回结果');
  });

  it('网络异常（fetch reject）→ 占位文本，不抛错', async () => {
    process.env.ZHIPU_API_KEY = 'k';
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });

    const out = await ocrImageFromZhipu(PNG, MIME, NAME);

    expect(out).toContain('未能提取文字');
  });
});
