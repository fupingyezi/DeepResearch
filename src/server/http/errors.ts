/**
 * 统一 HTTP 错误映射（app 层）。
 *
 * - AppError：service 层抛出的业务错误，自带 code + status
 * - ERROR_STATUS：域错误码 → HTTP 状态（逐条对齐既有路由行为）
 * - resolveHttpError：任意抛错 → { code, message, status }（纯函数，供单测）
 * - toHttpError：route 层 catch 的唯一出口
 * - jsonError：结构化错误响应 { code, message }（前端契约：auth 客户端读
 *   code/message，其余 API 客户端只读 status —— 错误体形状统一是安全的）
 */

import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

/** 业务错误：service 层抛出、toHttpError 统一映射为 HTTP 响应。 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(message: string, code: string, status: number, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * 域错误码 → HTTP 状态。值必须逐条对齐现状：
 * - harness 侧 ThreadServiceError（NOT_FOUND）/ ThreadMetaAccessError / ChatSessionAccessError
 *   （FORBIDDEN）只带 code 不带 status
 * - AuthErrorCode 与 app 域错误码共用同一张表（值域不冲突）
 * - pg 的 23505 等内部错误码**不**在表里：未知 code 一律按 500 处理，不外泄数据库细节
 */
export const ERROR_STATUS: Record<string, number> = {
  // 通用
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  UNAUTHENTICATED: 401,
  INVALID_INPUT: 400,
  INTERNAL: 500,
  // auth（与 AuthErrorCode 值一致）
  INVALID_CREDENTIALS: 401,
  EMAIL_ALREADY_EXISTS: 400,
  EMAIL_EXISTS: 400, // user-repository 的 EmailExistsError
  SYSTEM_ALREADY_INITIALIZED: 409,
  WEAK_PASSWORD: 400,
  // conversations
  SESSION_NOT_FOUND: 404,
  // files
  FILE_TOO_LARGE: 413,
  // model
  NO_API_KEY: 400,
  NO_MODEL_SELECTED: 400,
  PROVIDER_NOT_SUPPORTED: 400,
  PROVIDER_HAS_NO_KEY: 400,
  // extensions / memory
  EXTENSION_NOT_FOUND: 404,
  MEMORY_FACT_NOT_FOUND: 404,
  // prompt enhance
  MODEL_UNAVAILABLE: 503,
  EMPTY_RESULT: 502,
  // 停机中：优雅停机不再接受新 run，LB 依 503 摘除本实例
  SERVER_DRAINING: 503,
  // 占位路由（auth/oauth）
  NOT_IMPLEMENTED: 501,
};

export interface HttpErrorResolution {
  code: string;
  message: string;
  status: number;
}

/** 把任意抛错解析为 (code, message, status)。纯函数，供 toHttpError 与单测共用。 */
export function resolveHttpError(
  e: unknown,
  fallbackMessage = 'Internal server error',
): HttpErrorResolution {
  if (e instanceof AppError) {
    return { code: e.code, message: e.message, status: e.status };
  }
  if (e instanceof ZodError) {
    const message = e.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { code: 'INVALID_INPUT', message, status: 400 };
  }
  const err = e as Error & { code?: string };
  if (err && typeof err.code === 'string' && ERROR_STATUS[err.code] !== undefined) {
    return {
      code: err.code,
      message: err.message || fallbackMessage,
      status: ERROR_STATUS[err.code],
    };
  }
  return { code: 'INTERNAL', message: fallbackMessage, status: 500 };
}

/** 统一错误 → HTTP 响应。route 层 catch 的唯一出口。 */
export function toHttpError(e: unknown, fallbackMessage?: string): NextResponse {
  const { code, message, status } = resolveHttpError(e, fallbackMessage);
  return jsonError(code, message, status);
}

/** 结构化错误响应 { code, message }。 */
export function jsonError(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ code, message }, { status });
}

/** 状态码 → 兜底错误码（preflightError 用；不在 ERROR_STATUS 里的状态一律 INTERNAL）。 */
const STATUS_FALLBACK_CODE: Record<number, string> = {
  400: 'INVALID_INPUT',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  500: 'INTERNAL',
  502: 'EMPTY_RESULT',
  503: 'MODEL_UNAVAILABLE',
};

/**
 * service 预检元组 {ok:false, status, body} → 统一 {code,message} 响应（chat-service 零改动）。
 * body.error 大写后命中 ERROR_STATUS 则作 code（'no_api_key' → NO_API_KEY），否则按状态码回落；
 * message 优先取 body.message（no_api_key / no_model_selected 的用户可见中文不能丢），
 * 其次取 body.error 原文。
 */
export function preflightError(status: number, body: Record<string, unknown>): NextResponse {
  const errorKey = typeof body.error === 'string' ? body.error.toUpperCase() : undefined;
  const code =
    errorKey && ERROR_STATUS[errorKey] !== undefined
      ? errorKey
      : (STATUS_FALLBACK_CODE[status] ?? 'INTERNAL');
  const message =
    typeof body.message === 'string'
      ? body.message
      : typeof body.error === 'string'
        ? body.error
        : 'Request failed';
  return jsonError(code, message, status);
}
