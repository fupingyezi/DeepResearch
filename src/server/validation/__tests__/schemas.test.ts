import { describe, expect, it } from 'vitest';

import {
  chatStreamBodySchema,
  getThreadQuerySchema,
  historyQuerySchema,
  listQuerySchema,
  sandboxStatsQuerySchema,
  uuidSchema,
} from '../schemas';

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

describe('listQuerySchema（复刻现状 Number() 分页语义）', () => {
  it('缺省 → limit 50 / offset 0', () => {
    expect(listQuerySchema.parse({})).toEqual({ limit: 50, offset: 0, status: undefined });
  });

  it('非数字字符串回落默认，空串是 0，小数/负数透传', () => {
    expect(listQuerySchema.parse({ limit: 'abc', offset: '2' }).limit).toBe(50);
    expect(listQuerySchema.parse({ limit: '', offset: '' }).limit).toBe(0);
    expect(listQuerySchema.parse({ limit: '3.7', offset: '-5' })).toEqual({
      limit: 3.7,
      offset: -5,
      status: undefined,
    });
  });

  it('重复 key 取首值（对齐 searchParams.get）', () => {
    expect(listQuerySchema.parse({ limit: ['10', '20'] }).limit).toBe(10);
  });

  it('status 任意串透传（不 enum 化——未知值现状走 DB 过滤 200）', () => {
    expect(listQuerySchema.parse({ status: 'anything' }).status).toBe('anything');
  });
});

describe('historyQuerySchema', () => {
  it('缺 sessionId / 空串失败', () => {
    expect(historyQuerySchema.safeParse({}).success).toBe(false);
    expect(historyQuerySchema.safeParse({ sessionId: '' }).success).toBe(false);
  });

  it('非 uuid 也放行（现状 200 空结果，收紧会改状态码）', () => {
    expect(historyQuerySchema.parse({ sessionId: 'not-a-uuid' }).sessionId).toBe('not-a-uuid');
  });
});

describe('getThreadQuerySchema', () => {
  it('include=checkpoint → checkpoint，缺失/其余值 → undefined', () => {
    expect(getThreadQuerySchema.parse({}).include).toBeUndefined();
    expect(getThreadQuerySchema.parse({ include: 'checkpoint' }).include).toBe('checkpoint');
    expect(getThreadQuerySchema.parse({ include: 'state' }).include).toBeUndefined();
  });
});

describe('sandboxStatsQuerySchema', () => {
  it('stats 字符串透传，缺失 → undefined', () => {
    expect(sandboxStatsQuerySchema.parse({}).stats).toBeUndefined();
    expect(sandboxStatsQuerySchema.parse({ stats: '0' }).stats).toBe('0');
  });
});
