import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AppError,
  ERROR_STATUS,
  preflightError,
  resolveHttpError,
  toHttpError,
} from '@/server/http/errors';

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

describe('preflightError（service 预检元组 → 统一错误体）', () => {
  async function bodyOf(response: Response): Promise<Record<string, unknown>> {
    return (await response.json()) as Record<string, unknown>;
  }

  it("body.error 大写命中表 → 作 code（'no_api_key' → NO_API_KEY），中文 message 不丢", async () => {
    const response = preflightError(400, { error: 'no_api_key', message: '尚未配置 API Key' });
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({ code: 'NO_API_KEY', message: '尚未配置 API Key' });
  });

  it('错误码不在表 → 按状态回落，message 优先 body.message', async () => {
    const response = preflightError(403, { error: 'forbidden' });
    expect(response.status).toBe(403);
    expect(await bodyOf(response)).toEqual({ code: 'FORBIDDEN', message: 'forbidden' });
  });

  it('500 元组无 message → INTERNAL + error 原文', async () => {
    const response = preflightError(500, { error: 'failed to submit run' });
    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toEqual({ code: 'INTERNAL', message: 'failed to submit run' });
  });

  it('未知状态码 → INTERNAL 兜底（不外泄其他 code）', async () => {
    const response = preflightError(418, { error: 'teapot' });
    expect(response.status).toBe(418);
    expect(await bodyOf(response)).toEqual({ code: 'INTERNAL', message: 'teapot' });
  });
});
