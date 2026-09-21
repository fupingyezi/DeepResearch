import { describe, expect, it } from 'vitest';

import { chatStreamBodySchema, uuidSchema } from './schemas';

// 字段类型放宽为 unknown：测试要往里塞非法值验证边界，不能锁死推断类型
const validBody = () =>
  ({
    sessionId: '8f1e7a5c-9d4b-4e6a-9c3f-2b8d1a4e6f01',
    configuration: { model: { value: 'qwen3-235b-a22b' }, memoryEnabled: true, extra: 1 },
    message: { contents: [{ type: 'text', text: '你好' }] },
    stream: true,
    operation: undefined,
  }) as {
    sessionId: string;
    configuration: unknown;
    message: { contents: unknown[] };
    stream: boolean;
    operation: unknown;
  };

describe('chatStreamBodySchema', () => {
  it('合法 body 通过（含 configuration 多余键）', () => {
    expect(chatStreamBodySchema.safeParse(validBody()).success).toBe(true);
  });

  it('contents 为空 → 失败', () => {
    const body = validBody();
    body.message.contents = [];
    expect(chatStreamBodySchema.safeParse(body).success).toBe(false);
  });

  it('纯 file 无 text block → 失败', () => {
    const body = validBody();
    body.message.contents = [{ type: 'file', fileId: '8f1e7a5c-9d4b-4e6a-9c3f-2b8d1a4e6f01' }];
    expect(chatStreamBodySchema.safeParse(body).success).toBe(false);
  });

  it('text block 全空白 → 失败（refine 的至少一个非空 text）', () => {
    const body = validBody();
    body.message.contents = [{ type: 'text', text: '   \n' }];
    expect(chatStreamBodySchema.safeParse(body).success).toBe(false);
  });

  it('非法 operation → 失败', () => {
    const body = validBody();
    body.operation = 'replay';
    expect(chatStreamBodySchema.safeParse(body).success).toBe(false);
  });

  it('非 uuid sessionId → 失败（不再当作任意字符串建会话）', () => {
    const body = validBody();
    body.sessionId = 'not-a-uuid';
    expect(chatStreamBodySchema.safeParse(body).success).toBe(false);
  });

  it('file block 缺 fileId → 失败', () => {
    const body = validBody();
    body.message.contents = [{ type: 'file' }];
    expect(chatStreamBodySchema.safeParse(body).success).toBe(false);
  });

  it('configuration 为 null 放行（历史协议允许显式 null）', () => {
    const body = validBody();
    body.configuration = null;
    expect(chatStreamBodySchema.safeParse(body).success).toBe(true);
  });
});

describe('uuidSchema', () => {
  it('标准 uuid 通过，其余失败', () => {
    expect(uuidSchema.safeParse('8f1e7a5c-9d4b-4e6a-9c3f-2b8d1a4e6f01').success).toBe(true);
    expect(uuidSchema.safeParse('abc').success).toBe(false);
  });
});
