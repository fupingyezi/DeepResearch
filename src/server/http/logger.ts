/**
 * HTTP 访问日志（统一请求管线专用，零依赖，纯 console）。
 *
 * - logHttpRequest：每个请求一条完成日志（鉴权/校验/限流短路也记）
 * - logHttpError：未捕获异常的 error 级日志，与完成行成对出现
 *
 * path 只记 pathname（不含 query）：memory/retrieve 的 q= 等查询参数不进日志。
 */

export interface HttpLogEntry {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  userId?: string;
}

export function logHttpRequest({ method, path, status, durationMs, userId }: HttpLogEntry): void {
  const userPart = userId ? ` user=${userId}` : '';
  console.log(`[http] ${method} ${path} ${status} ${durationMs}ms${userPart}`);
}

export function logHttpError(method: string, path: string, e: unknown): void {
  console.error(`[http] ${method} ${path} failed:`, e);
}
