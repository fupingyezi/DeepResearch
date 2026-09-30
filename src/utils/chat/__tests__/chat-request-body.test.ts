import { describe, expect, it } from 'vitest';

import type { ChatUploadedFileRef } from '@/types';
import { buildChatRequestBody } from '../chat-request-body';

function fileRefs(list: Array<{ id: string; mime: string }>): ChatUploadedFileRef[] {
  return list.map((f) => ({ fileId: f.id, mimeType: f.mime }));
}

describe('buildChatRequestBody', () => {
  it('新建对话（isNewSession）：请求体不带 sessionId，contents 只有 text', () => {
    const body = buildChatRequestBody({ inputValue: '你好', isNewSession: true });
    expect(body.sessionId).toBeUndefined();
    expect(body.message).toEqual({ contents: [{ type: 'text', text: '你好' }] });
    expect(body.stream).toBe(true);
    expect(body.operation).toBeUndefined();
  });

  it('续聊：请求体携带 sessionId', () => {
    const body = buildChatRequestBody({ inputValue: '继续', sessionId: 's-1' });
    expect(body.sessionId).toBe('s-1');
  });

  it('resume：text 优先取 resumeDecision，携带 operation，附件不生效', () => {
    const body = buildChatRequestBody({
      inputValue: '原始问题',
      operation: 'resume',
      resumeDecision: '确认',
      sessionId: 's-1',
      uploadedFiles: fileRefs([{ id: 'f1', mime: 'image/png' }]),
    });
    expect(body.operation).toBe('resume');
    expect(body.message).toEqual({ contents: [{ type: 'text', text: '确认' }] });
  });

  it('附件：按 mimeType 分 image/file 两种 content block', () => {
    const body = buildChatRequestBody({
      inputValue: '看下这两个文件',
      sessionId: 's-1',
      uploadedFiles: fileRefs([
        { id: 'f1', mime: 'image/png' },
        { id: 'f2', mime: 'application/pdf' },
      ]),
    });
    expect(body.message).toEqual({
      contents: [
        { type: 'text', text: '看下这两个文件' },
        { type: 'image', fileId: 'f1' },
        { type: 'file', fileId: 'f2' },
      ],
    });
  });

  it('附件缺 fileId 的脏数据被跳过', () => {
    const dirty = [{ fileId: '', mimeType: 'image/png' }] as unknown as ChatUploadedFileRef[];
    const body = buildChatRequestBody({
      inputValue: 'hi',
      sessionId: 's-1',
      uploadedFiles: dirty,
    });
    expect(body.message).toEqual({ contents: [{ type: 'text', text: 'hi' }] });
  });

  it('recall / reEditCall：携带 operation，不带附件', () => {
    const body = buildChatRequestBody({
      inputValue: '重新生成',
      operation: 'recall',
      sessionId: 's-1',
      uploadedFiles: fileRefs([{ id: 'f1', mime: 'application/pdf' }]),
    });
    expect(body.operation).toBe('recall');
    expect(body.message).toEqual({ contents: [{ type: 'text', text: '重新生成' }] });
  });

  it('configuration：model 与 memoryMode 组装进 configuration 段', () => {
    const body = buildChatRequestBody({
      inputValue: 'hi',
      sessionId: 's-1',
      model: 'deepseek-v4-pro',
      memoryMode: 'retrieve',
    });
    expect(body.configuration).toEqual({
      model: { value: 'deepseek-v4-pro' },
      memoryMode: 'retrieve',
    });
  });

  it('非法 memoryMode 字面量不静默回落，直接不携带', () => {
    const body = buildChatRequestBody({
      inputValue: 'hi',
      sessionId: 's-1',
      memoryMode: 'retrive' as never,
    });
    expect(body.configuration).toBeUndefined();
  });

  it('无 model 与 memoryMode 时不携带 configuration 键', () => {
    const body = buildChatRequestBody({ inputValue: 'hi', sessionId: 's-1' });
    expect(body.configuration).toBeUndefined();
  });
});
