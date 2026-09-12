import { describe, expect, it } from 'vitest';

import type { ChatUploadedFileRef } from '@/types';

import { buildAttachmentParts } from './attachment-parts';

const PNG: ChatUploadedFileRef = {
  fileId: 'f-png',
  mimeType: 'image/png',
  filename: 'shot.png',
  sizeBytes: 12345,
};

const PDF: ChatUploadedFileRef = {
  fileId: 'f-pdf',
  mimeType: 'application/pdf',
  filename: 'doc.pdf',
  sizeBytes: 6789,
};

/**
 * 回归守卫：本地乐观消息必须自带附件 part。
 * 缺了它，用户刚发出带附件的消息时气泡里看不到附件（刷新后从服务端读历史才出现）。
 */
describe('buildAttachmentParts', () => {
  it('无附件 → 空数组', () => {
    expect(buildAttachmentParts(undefined)).toEqual([]);
    expect(buildAttachmentParts([])).toEqual([]);
  });

  it('image/* 生成 image part，其余生成 file part', () => {
    const parts = buildAttachmentParts([PNG, PDF]);
    expect(parts.map((p) => p.type)).toEqual(['image', 'file']);
  });

  it('携带 fileId / 文件名 / 大小，供气泡渲染真实文件名', () => {
    const [part] = buildAttachmentParts([PNG]);
    expect(part).toMatchObject({
      type: 'image',
      content: { fileId: 'f-png', filename: 'shot.png', mimeType: 'image/png', sizeBytes: 12345 },
    });
  });

  it('每个 part 有唯一 partId（列表 key 依赖它）', () => {
    const parts = buildAttachmentParts([PNG, PDF]);
    expect(parts[0].partId).toBeTruthy();
    expect(parts[0].partId).not.toBe(parts[1].partId);
  });

  it('mimeType 缺失时按 file 处理（不误判为图片）', () => {
    const [part] = buildAttachmentParts([{ fileId: 'x', mimeType: '' }]);
    expect(part.type).toBe('file');
  });
});
