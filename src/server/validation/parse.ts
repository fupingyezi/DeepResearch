/**
 * 请求解析辅助：JSON body / searchParams → zod 校验。
 * 校验失败直接产出 400 响应（{ ok: false, response }），route 层判断 ok 与否即可。
 */

import { NextRequest, NextResponse } from 'next/server';
import type { ZodError, ZodType } from 'zod';

import { jsonError } from '@/server/http/errors';

export type ParseResult<T> = { ok: true; data: T } | { ok: false; response: NextResponse };

function invalidInputResponse(error: ZodError): NextResponse {
  const message = error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return jsonError('INVALID_INPUT', message, 400);
}

/** 解析并校验 JSON body；JSON 非法或校验失败 → 400 INVALID_INPUT。 */
export async function parseJsonBody<T>(
  request: NextRequest,
  schema: ZodType<T>,
): Promise<ParseResult<T>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: jsonError('INVALID_INPUT', 'Invalid JSON body', 400) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, response: invalidInputResponse(parsed.error) };
  return { ok: true, data: parsed.data };
}

/** 把 URLSearchParams 折叠为对象后走 zod 校验（重复 key 收敛为 string[]）。 */
export function parseSearchParams<T>(
  searchParams: URLSearchParams,
  schema: ZodType<T>,
): ParseResult<T> {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of searchParams.entries()) {
    if (raw[key] === undefined) raw[key] = value;
    else if (Array.isArray(raw[key])) (raw[key] as string[]).push(value);
    else raw[key] = [raw[key] as string, value];
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: invalidInputResponse(parsed.error) };
  return { ok: true, data: parsed.data };
}
