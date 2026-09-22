import { describe, expect, it, vi } from 'vitest';

import { logHttpError, logHttpRequest } from '@/server/http/logger';

describe('logHttpRequest', () => {
  it('单行完成日志（无 user 段）', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logHttpRequest({ method: 'GET', path: '/api/memory/mode', status: 200, durationMs: 12 });
    expect(spy).toHaveBeenCalledWith('[http] GET /api/memory/mode 200 12ms');
    spy.mockRestore();
  });

  it('有 userId 时追加 user 段', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logHttpRequest({
      method: 'POST',
      path: '/api/v3/chat',
      status: 500,
      durationMs: 300,
      userId: 'u1',
    });
    expect(spy).toHaveBeenCalledWith('[http] POST /api/v3/chat 500 300ms user=u1');
    spy.mockRestore();
  });
});

describe('logHttpError', () => {
  it('error 级单行 + 原始错误对象', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = new Error('boom');
    logHttpError('POST', '/api/test', e);
    expect(spy).toHaveBeenCalledWith('[http] POST /api/test failed:', e);
    spy.mockRestore();
  });
});
