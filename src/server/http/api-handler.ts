/**
 * 统一请求管线（withApiHandler）：全部 API 路由的横切关注点收敛点。
 *
 * 执行序（错误处理包裹全流程）：
 *   try/catch 全包裹
 *     → auth（'cookie' 缺省 = getCurrentUser；'none'；自定义 resolver，null → 401）
 *     → guard（sandbox token 等非用户主体门禁，false → 401）
 *     → userIdHeader（threads 的 x-user-id → ctx.userId，可空不 401）
 *     → rateLimit（占位钩子，非 null Response 短路）
 *     → body 解析（ZodType → parseJsonBody；函数 → 自定义解析如 multipart）
 *     → query 解析（parseSearchParams）
 *     → handler(ctx)
 *   每条返回路径（401/400/限流短路/正常返回）各记一条完成日志；
 *   catch 先 logHttpError 再 toHttpError(e, fallbackMessage)。
 *
 * handler 约定：
 * - wrapper 是 body 唯一读取方，handler 内不得再调 request.json()/formData()（二次读取报 Body unusable）
 * - handler 返回值原样透传（NextResponse / SSE 的 plain Response 均可，严禁把 SSE 包进 NextResponse.json）
 * - auth 'cookie' 通过时 ctx.user 必非空
 */

import type { NextRequest } from 'next/server';
import type { UserRecord } from '@deerflow-harness/auth';
import type { ZodType } from 'zod';

import { parseJsonBody, parseSearchParams, type ParseResult } from '@/server/validation';
import { getCurrentUser } from './auth';
import { jsonError, toHttpError } from './errors';
import { logHttpError, logHttpRequest } from './logger';
import { noopRateLimit, type RateLimitHook } from './rate-limit';

/** 自定义鉴权解析：返回 null → 401 UNAUTHENTICATED（预留，当前无消费路由）。 */
export type AuthResolver = (request: NextRequest) => Promise<UserRecord | null> | UserRecord | null;

export interface ApiHandlerOptions<TBody = undefined, TQuery = undefined> {
  /** 缺省 'cookie'（getCurrentUser，null → 401）；'none' 跳过；函数为自定义解析。 */
  auth?: 'cookie' | 'none' | AuthResolver;
  /** 附加布尔门禁（非用户主体鉴权，如 sandbox token），false → 401。 */
  guard?: (request: NextRequest) => boolean | Promise<boolean>;
  /** 从指定 header 读取可选 user_id 注入 ctx.userId（threads 的 x-user-id，无 401）。 */
  userIdHeader?: string;
  /** ZodType → parseJsonBody（json 模式）；函数 → 自定义解析（multipart 等）；缺省不解析。 */
  body?: ZodType<TBody> | ((request: NextRequest) => Promise<ParseResult<TBody>>);
  /** → parseSearchParams(request.nextUrl.searchParams, schema)；缺省不解析。 */
  query?: ZodType<TQuery>;
  /** 未知错误 500 的 message（prompt/enhance 传 '增强失败' 等用户可见文案；缺省 'Internal server error'）。 */
  fallbackMessage?: string;
  /** 限流钩子（占位），缺省 no-op。 */
  rateLimit?: RateLimitHook;
}

export interface ApiContext<TBody, TQuery> {
  user: UserRecord | null; // auth 'cookie' 通过时必非空
  userId?: string; // userIdHeader 命中时
  body: TBody;
  query: TQuery;
  params: Record<string, string>; // 动态路由段（无动态段时为 {}）
  request: NextRequest; // 供 SSE 组装 createSseStream(request, ...)
}

export type ApiRouteHandler<TBody, TQuery> = (
  ctx: ApiContext<TBody, TQuery>,
) => Response | Promise<Response>;

/**
 * 包一层统一管线。返回 Next.js route handler 形状
 * `(request, { params }) => Promise<Response>`，路由层直接 `export const GET = withApiHandler(...)`。
 *
 * TBody / TQuery 由 options.body / options.query 的 schema 推断；不要显式传
 * 类型参数——部分显式类型参数会让未指定的项退回默认值 undefined 而非推断
 * （TS 不支持按名传泛型）。
 */
export function withApiHandler<TBody = undefined, TQuery = undefined>(
  options: ApiHandlerOptions<TBody, TQuery>,
  handler: ApiRouteHandler<TBody, TQuery>,
): (request: NextRequest, routeCtx?: { params?: Record<string, string> }) => Promise<Response> {
  const auth = options.auth ?? 'cookie';
  const rateLimit = options.rateLimit ?? noopRateLimit;

  return async (request, routeCtx) => {
    const { method } = request;
    const path = request.nextUrl.pathname; // 不含 query：查询参数不进日志
    const startedAt = Date.now();

    const finish = (response: Response, userId?: string): Response => {
      logHttpRequest({
        method,
        path,
        status: response.status,
        durationMs: Date.now() - startedAt,
        userId,
      });
      return response;
    };

    try {
      // 1) 鉴权
      let user: UserRecord | null = null;
      if (auth === 'cookie') {
        user = await getCurrentUser(request);
      } else if (typeof auth === 'function') {
        user = (await auth(request)) ?? null;
      }
      if (auth !== 'none' && user === null) {
        return finish(jsonError('UNAUTHENTICATED', 'Not authenticated', 401));
      }

      // 2) 非用户主体门禁
      if (options.guard && !(await options.guard(request))) {
        return finish(jsonError('UNAUTHENTICATED', 'Not authenticated', 401), user?.id);
      }

      // 3) 可选 user_id 头（threads 的 x-user-id）
      const headerUserId = options.userIdHeader
        ? (request.headers.get(options.userIdHeader) ?? undefined)
        : undefined;

      // 4) 限流（占位）
      const limited = await rateLimit(request);
      if (limited) return finish(limited, user?.id ?? headerUserId);

      // 5) body 解析（wrapper 是唯一读取方）
      let body: TBody = undefined as TBody;
      if (typeof options.body === 'function') {
        const parsed = await options.body(request);
        if (!parsed.ok) return finish(parsed.response, user?.id ?? headerUserId);
        body = parsed.data;
      } else if (options.body) {
        const parsed = await parseJsonBody(request, options.body);
        if (!parsed.ok) return finish(parsed.response, user?.id ?? headerUserId);
        body = parsed.data;
      }

      // 6) query 解析
      let query: TQuery = undefined as TQuery;
      if (options.query) {
        const parsed = parseSearchParams(request.nextUrl.searchParams, options.query);
        if (!parsed.ok) return finish(parsed.response, user?.id ?? headerUserId);
        query = parsed.data;
      }

      // 7) handler
      const ctx: ApiContext<TBody, TQuery> = {
        user,
        userId: headerUserId,
        body,
        query,
        params: routeCtx?.params ?? {},
        request,
      };
      const response = await handler(ctx);
      return finish(response, user?.id ?? headerUserId);
    } catch (e) {
      logHttpError(method, path, e);
      return finish(toHttpError(e, options.fallbackMessage));
    }
  };
}
