import { describe, expect, it } from 'vitest';

import { extractContentTextBlocks } from './content-blocks';

describe('extractContentTextBlocks', () => {
  it('string content 原样返回', () => {
    expect(extractContentTextBlocks('hello')).toBe('hello');
  });

  it('只取 text blocks，多个用换行拼接', () => {
    expect(
      extractContentTextBlocks([
        { type: 'text', text: '第一行' },
        { type: 'text', text: '第二行' },
      ]),
    ).toBe('第一行\n第二行');
  });

  /**
   * 这是「base64 不得进 SSE」的不变量：view_image 返回的多模态 ToolMessage
   * 若把 image_url block 原样送出，一次 tool_result 就能灌爆 SSE 事件与前端 parts-reducer。
   */
  it('全 image blocks 时返回空串（不泄漏 base64）', () => {
    const out = extractContentTextBlocks([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
    expect(out).toBe('');
    expect(out).not.toContain('base64');
  });

  it('文本 + 图片混合时只保留文本', () => {
    const out = extractContentTextBlocks([
      { type: 'text', text: '已加载图片' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
    expect(out).toBe('已加载图片');
    expect(out).not.toContain('base64');
  });

  it('null / undefined → 空串', () => {
    expect(extractContentTextBlocks(null)).toBe('');
    expect(extractContentTextBlocks(undefined)).toBe('');
  });
});
