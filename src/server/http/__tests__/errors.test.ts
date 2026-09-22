import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AppError, ERROR_STATUS, resolveHttpError, toHttpError } from '@/server/http/errors';

function errorWithCode(code: string, message = 'boom'): Error {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

describe('resolveHttpError', () => {
  it('AppError 透传自身的 code/message/status', () => {
    const r = resolveHttpError(new AppError('文件太大', 'FILE_TOO_LARGE', 413));
    expect(r).toEqual({ code: 'FILE_TOO_LARGE', message: '文件太大', status: 413 });
  });

  it('带 code 的域错误查表映射', () => {
    expect(resolveHttpError(errorWithCode('NOT_FOUND')).status).toBe(404);
    expect(resolveHttpError(errorWithCode('FORBIDDEN')).status).toBe(403);
    expect(resolveHttpError(errorWithCode('EMAIL_EXISTS')).status).toBe(400);
    expect(resolveHttpError(errorWithCode('UNAUTHENTICATED')).status).toBe(401);
    expect(resolveHttpError(errorWithCode('SESSION_NOT_FOUND')).status).toBe(404);
  });

  it('zod 校验失败 → 400 INVALID_INPUT', () => {
    const parsed = z.object({ name: z.string() }).safeParse({ name: 42 });
    if (parsed.success) throw new Error('unreachable');
    const r = resolveHttpError(parsed.error);
    expect(r.code).toBe('INVALID_INPUT');
    expect(r.status).toBe(400);
  });

  it('未知 code（含 pg 23505）→ 500 INTERNAL，不外泄', () => {
    expect(resolveHttpError(errorWithCode('23505')).status).toBe(500);
    expect(resolveHttpError(errorWithCode('SOME_UNKNOWN')).status).toBe(500);
  });

  it('无 code 的 Error / 非 Error 值 → 500 INTERNAL', () => {
    expect(resolveHttpError(new Error('boom')).status).toBe(500);
    expect(resolveHttpError('string thrown').status).toBe(500);
    expect(resolveHttpError(undefined).status).toBe(500);
  });
});

describe('toHttpError', () => {
  it('状态码与 resolveHttpError 一致', () => {
    expect(toHttpError(errorWithCode('NOT_FOUND')).status).toBe(404);
    expect(toHttpError(new AppError('x', 'EMPTY_RESULT', 502)).status).toBe(502);
    expect(toHttpError(new Error('unknown')).status).toBe(500);
  });
});

describe('ERROR_STATUS 表', () => {
  it('与 harness 错误码约定的关键条目对齐', () => {
    // ThreadServiceError 的 NOT_FOUND / 归属校验的 FORBIDDEN 是 route 层最依赖的两条
    expect(ERROR_STATUS.NOT_FOUND).toBe(404);
    expect(ERROR_STATUS.FORBIDDEN).toBe(403);
  });
});
