import { NextRequest, NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { UserRecord } from '@deerflow-harness/auth';

import { withApiHandler } from '@/server/http/api-handler';
import { authenticateWithRefresh, setAuthCookies } from '@/server/http/auth';
import { AppError, jsonError } from '@/server/http/errors';
import { listQuerySchema } from '@/server/validation/schemas';

vi.mock('@/server/http/auth', () => ({
  authenticateWithRefresh: vi.fn(),
  setAuthCookies: vi.fn(),
}));

const authenticateWithRefreshMock = vi.mocked(authenticateWithRefresh);
const setAuthCookiesMock = vi.mocked(setAuthCookies);

const user = {
  id: 'u1',
  email: 'u1@example.com',
  passwordHash: 'x',
  systemRole: 'user',
  needsSetup: false,
  emailVerified: true,
  tokenVersion: 1,
  createdAt: '',
  updatedAt: '',
} as UserRecord;

// NextRequest 的 init 类型比 DOM RequestInit 窄（signal 不允许 null）
type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

function requestAt(path: string, init: NextRequestInit = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, init);
}

function jsonRequest(path: string, body: unknown): NextRequest {
  return requestAt(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function errorWithCode(code: string, message = 'boom'): Error {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('返回透传与完成日志', () => {
  it('NextResponse 原样透传；auth none → user null、body/query undefined；一条完成日志', async () => {
    const wrapped = withApiHandler({ auth: 'none' }, async (ctx) => {
      expect(ctx.user).toBeNull();
      expect(ctx.body).toBeUndefined();
      expect(ctx.query).toBeUndefined();
      return NextResponse.json({ ok: true });
    });
    const response = await wrapped(requestAt('/api/test'));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/^\[http\] GET \/api\/test 200 \d+ms$/);
  });

  it('plain Response（SSE 形态）原样透传，头与 body 不动', async () => {
    const wrapped = withApiHandler(
      { auth: 'none' },
      () =>
        new Response('data: x\n\n', {
          headers: { 'content-type': 'text/event-stream', 'x-custom': '1' },
        }),
    );
    const response = await wrapped(requestAt('/api/v3/chat'));
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-custom')).toBe('1');
    expect(await response.text()).toBe('data: x\n\n');
  });

  it('cookie 登录通过 → ctx.user 非空，完成日志带 user 段', async () => {
    authenticateWithRefreshMock.mockResolvedValue({ user });
    const wrapped = withApiHandler({}, async (ctx) => {
      expect(ctx.user?.id).toBe('u1');
      return NextResponse.json({});
    });
    await wrapped(requestAt('/api/test'));
    expect(logSpy.mock.calls[0][0]).toContain(' user=u1');
  });

  it('path 只记 pathname，查询参数不进日志', async () => {
    const wrapped = withApiHandler({ auth: 'none' }, () => NextResponse.json({}));
    await wrapped(requestAt('/api/memory/retrieve?q=secret'));
    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toContain('/api/memory/retrieve');
    expect(line).not.toContain('secret');
  });
});

describe('错误路径（catch → logHttpError → toHttpError）', () => {
  it('普通 Error → 500 INTERNAL 标准体，console.error 一次，完成日志 500', async () => {
    const wrapped = withApiHandler({ auth: 'none' }, () => {
      throw new Error('boom');
    });
    const response = await wrapped(requestAt('/api/test'));
    expect(response.status).toBe(500);
    expect(await readJson(response)).toEqual({
      code: 'INTERNAL',
      message: 'Internal server error',
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/ 500 /);
  });

  it('fallbackMessage 生效（未知错误的用户可见文案）', async () => {
    const wrapped = withApiHandler({ auth: 'none', fallbackMessage: '增强失败' }, () => {
      throw new Error('x');
    });
    expect((await readJson(await wrapped(requestAt('/api/test')))).message).toBe('增强失败');
  });

  it('AppError 透传自身 code/message/status', async () => {
    const wrapped = withApiHandler({ auth: 'none' }, () => {
      throw new AppError('文件太大', 'FILE_TOO_LARGE', 413);
    });
    const response = await wrapped(requestAt('/api/test'));
    expect(response.status).toBe(413);
    expect(await readJson(response)).toEqual({ code: 'FILE_TOO_LARGE', message: '文件太大' });
  });

  it('带 code 的域错误查 ERROR_STATUS 表映射', async () => {
    const wrapped = withApiHandler({ auth: 'none' }, () => {
      throw errorWithCode('NOT_FOUND', 'not found');
    });
    const response = await wrapped(requestAt('/api/threads/missing'));
    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ code: 'NOT_FOUND', message: 'not found' });
  });
});

describe('鉴权', () => {
  it("'cookie' 未登录 → 401 标准体，handler 不执行，不写刷新 cookie", async () => {
    authenticateWithRefreshMock.mockResolvedValue({ user: null });
    const handler = vi.fn(() => NextResponse.json({}));
    const wrapped = withApiHandler({}, handler);
    const response = await wrapped(requestAt('/api/test'));
    expect(response.status).toBe(401);
    expect(await readJson(response)).toEqual({
      code: 'UNAUTHENTICATED',
      message: 'Not authenticated',
    });
    expect(handler).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(setAuthCookiesMock).not.toHaveBeenCalled();
  });

  it('透明刷新命中 → setAuthCookies 调一次（新 token 对挂上响应），handler 照跑', async () => {
    const tokens = { accessToken: 'a', refreshToken: 'r' };
    authenticateWithRefreshMock.mockResolvedValue({ user, tokens });
    const handler = vi.fn(() => NextResponse.json({ ok: true }));
    const wrapped = withApiHandler({}, handler);
    const response = await wrapped(requestAt('/api/test'));
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(setAuthCookiesMock).toHaveBeenCalledTimes(1);
    expect(setAuthCookiesMock.mock.calls[0][0]).toBe(response);
    expect(setAuthCookiesMock.mock.calls[0][1]).toEqual(tokens);
  });

  it('自定义 resolver 返回 null → 401', async () => {
    const wrapped = withApiHandler({ auth: async () => null }, () => NextResponse.json({}));
    const response = await wrapped(requestAt('/api/test'));
    expect(response.status).toBe(401);
  });

  it('guard false → 401，完成日志带已登录 userId', async () => {
    authenticateWithRefreshMock.mockResolvedValue({ user });
    const handler = vi.fn(() => NextResponse.json({}));
    const wrapped = withApiHandler({ guard: () => false }, handler);
    const response = await wrapped(requestAt('/api/test'));
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(logSpy.mock.calls[0][0]).toContain(' user=u1');
  });
});

describe('userIdHeader', () => {
  it('命中 → ctx.userId；缺失 → undefined（均不 401）', async () => {
    const captured: Array<string | undefined> = [];
    const wrapped = withApiHandler({ auth: 'none', userIdHeader: 'x-user-id' }, async (ctx) => {
      captured.push(ctx.userId);
      return NextResponse.json({});
    });
    await wrapped(requestAt('/api/threads', { headers: { 'x-user-id': 'external-1' } }));
    await wrapped(requestAt('/api/threads'));
    expect(captured).toEqual(['external-1', undefined]);
  });
});

describe('body 解析', () => {
  it('zod 合法 → ctx.body 为解析结果', async () => {
    const wrapped = withApiHandler(
      { auth: 'none', body: z.object({ name: z.string() }) },
      async (ctx) => {
        expect(ctx.body.name).toBe('x');
        return NextResponse.json({});
      },
    );
    await wrapped(jsonRequest('/api/test', { name: 'x' }));
  });

  it('zod 非法 → 400 INVALID_INPUT，handler 不执行', async () => {
    const handler = vi.fn(() => NextResponse.json({}));
    const wrapped = withApiHandler({ auth: 'none', body: z.object({ name: z.string() }) }, handler);
    const response = await wrapped(jsonRequest('/api/test', { name: 42 }));
    expect(response.status).toBe(400);
    expect((await readJson(response)).code).toBe('INVALID_INPUT');
    expect(handler).not.toHaveBeenCalled();
  });

  it('非法 JSON → 400 INVALID_INPUT', async () => {
    const wrapped = withApiHandler({ auth: 'none', body: z.object({}) }, () =>
      NextResponse.json({}),
    );
    const response = await wrapped(
      requestAt('/api/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
    );
    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({
      code: 'INVALID_INPUT',
      message: 'Invalid JSON body',
    });
  });

  it('函数模式 ok → data 透传（multipart 等自定义解析）', async () => {
    const wrapped = withApiHandler(
      { auth: 'none', body: async () => ({ ok: true as const, data: 'custom' }) },
      async (ctx) => {
        expect(ctx.body).toBe('custom');
        return NextResponse.json({});
      },
    );
    await wrapped(requestAt('/api/test', { method: 'POST' }));
  });

  it('函数模式 !ok → 短路返回解析器自己的响应，handler 不执行', async () => {
    const handler = vi.fn(() => NextResponse.json({}));
    const wrapped = withApiHandler(
      { auth: 'none', body: async () => ({ ok: false, response: jsonError('X', 'custom', 418) }) },
      handler,
    );
    const response = await wrapped(requestAt('/api/test', { method: 'POST' }));
    expect(response.status).toBe(418);
    expect(handler).not.toHaveBeenCalled();
  });

  it('解析器抛错 → 500 + 日志', async () => {
    const wrapped = withApiHandler(
      {
        auth: 'none',
        body: async () => {
          throw new Error('parse blew up');
        },
      },
      () => NextResponse.json({}),
    );
    const response = await wrapped(requestAt('/api/test', { method: 'POST' }));
    expect(response.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe('query 解析', () => {
  it('合法 → ctx.query 为解析结果', async () => {
    const wrapped = withApiHandler({ auth: 'none', query: listQuerySchema }, async (ctx) => {
      expect(ctx.query.limit).toBe(10);
      expect(ctx.query.offset).toBe(2);
      return NextResponse.json({});
    });
    await wrapped(requestAt('/api/threads?limit=10&offset=2'));
  });

  it('非法 → 400 INVALID_INPUT，handler 不执行', async () => {
    const handler = vi.fn(() => NextResponse.json({}));
    const wrapped = withApiHandler({ auth: 'none', query: z.object({ id: z.number() }) }, handler);
    const response = await wrapped(requestAt('/api/test?id=abc'));
    expect(response.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('限流与参数', () => {
  it('rateLimit 返回 Response → 短路，完成日志照记', async () => {
    const handler = vi.fn(() => NextResponse.json({}));
    const wrapped = withApiHandler(
      {
        auth: 'none',
        rateLimit: () =>
          NextResponse.json({ code: 'TOO_MANY_REQUESTS', message: 'slow down' }, { status: 429 }),
      },
      handler,
    );
    const response = await wrapped(requestAt('/api/test'));
    expect(response.status).toBe(429);
    expect(handler).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('params 透传（动态路由）', async () => {
    const wrapped = withApiHandler({ auth: 'none' }, async (ctx) => {
      expect(ctx.params.id).toBe('abc');
      return NextResponse.json({});
    });
    await wrapped(requestAt('/api/threads/abc'), { params: { id: 'abc' } });
  });
});

describe('错误态响应', () => {
  it('handler 返回 404 → 完成行 404，无 error 日志', async () => {
    const wrapped = withApiHandler({ auth: 'none' }, () =>
      jsonError('NOT_FOUND', 'not found', 404),
    );
    const response = await wrapped(requestAt('/api/threads/missing'));
    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ code: 'NOT_FOUND', message: 'not found' });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls[0][0]).toMatch(/ 404 /);
  });
});
