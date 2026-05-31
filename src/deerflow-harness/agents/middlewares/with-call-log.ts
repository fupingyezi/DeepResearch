import type { AgentMiddleware } from 'langchain';

/**
 * withCallLog
 *
 * 把任意 AgentMiddleware 的 hook 包一层调用日志：
 *   [mw:<MiddlewareName>] <hook> ▶ enter
 *   [mw:<MiddlewareName>] <hook> ◀ exit (Xms)
 *   [mw:<MiddlewareName>] <hook> ✗ error (Xms): <message>
 *
 * 设计要点：
 * 1. 不修改原中间件文件，只在装配阶段统一装饰，避免散落 console.log。
 * 2. 仅装饰真实存在的 hook —— 占位中间件没有任何 hook，不会产出噪声。
 * 3. wrapModelCall / wrapToolCall 的 handler 也会被包一层（before-handler / after-handler），
 *    便于看清"进入了哪几层 wrap、handler 真正耗时在哪一层"。
 * 4. 通过 env `MW_TRACE` 关闭（设为 "0"/"false"），默认开启。
 * 5. 不改变任何运行时契约：返回值、抛出异常、引用透明性都与原 hook 一致。
 *
 * 大对象不会被序列化进日志，避免 token / 性能开销；只打 hook 名 + 耗时 + 错误摘要。
 */

const HOOKS = [
  'beforeAgent',
  'beforeModel',
  'afterModel',
  'afterAgent',
  'wrapModelCall',
  'wrapToolCall',
] as const;

export interface WithCallLogOptions {
  /** 自定义日志器，默认 console */
  logger?: Pick<Console, 'info' | 'error'>;
  /**
   * 是否启用。默认读取 env MW_TRACE：
   *  - 未设置 / "1" / "true" → 启用
   *  - "0" / "false"          → 关闭，直接返回原中间件
   */
  enabled?: boolean;
  /** 每条日志的前缀，默认 "[mw:<name>]" */
  prefix?: (mwName: string) => string;
}

function isTraceEnabledByEnv(): boolean {
  const v = process.env.MW_TRACE;
  if (v == null) return true;
  const s = v.trim().toLowerCase();
  return !(s === '0' || s === 'false' || s === 'off' || s === 'no');
}

/** 计时器：返回毫秒级耗时。 */
function startTimer(): () => string {
  const t0 = Date.now();
  return () => `${(Date.now() - t0).toFixed(0)}ms`;
}

/** 把任意错误描述压缩成一行，避免巨型堆栈污染日志。 */
function describeErr(err: any): string {
  if (err instanceof Error) return `${err.constructor?.name || 'Error'}: ${err.message}`;
  try {
    return typeof err === 'string' ? err : JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function withCallLog<M extends AgentMiddleware>(
  middleware: M,
  options: WithCallLogOptions = {},
): M {
  const enabled = options.enabled ?? isTraceEnabledByEnv();
  if (!enabled) return middleware;

  // AgentMiddleware 是带有 hook 字段的对象；为了通用地遍历与覆写其上的 hook，
  // 这里需要把它当成一个字符串索引的对象处理（双层断言绕过结构性类型差异）。
  const mw = middleware as unknown as Record<string, unknown> & { name?: string };
  const mwName = mw.name || 'UnknownMiddleware';
  const logger = options.logger ?? console;
  const prefix = options.prefix ?? ((n: string) => `[mw:${n}]`);
  const tag = prefix(mwName);

  // 浅拷贝产出新对象，避免污染原中间件实例（可能被多处共享）
  const decorated: Record<string, unknown> = { ...mw };

  for (const hook of HOOKS) {
    const original = mw[hook];
    if (typeof original !== 'function') continue;

    if (hook === 'wrapModelCall' || hook === 'wrapToolCall') {
      // wrap-style: (request, handler) => Promise<result>
      decorated[hook] = async function wrappedWrapHook(
        request: any,
        handler: (req: any) => Promise<any>,
      ) {
        const elapsed = startTimer();
        logger.info(`${tag} ${hook} ▶ enter`);
        // 给 handler 也打日志，便于看出"模型/工具实际耗时" vs "本中间件包装耗时"
        const tracedHandler = async (req: any) => {
          const handlerElapsed = startTimer();
          logger.info(`${tag} ${hook} → handler ▶`);
          try {
            const r = await handler(req);
            logger.info(`${tag} ${hook} → handler ◀ (${handlerElapsed()})`);
            return r;
          } catch (err) {
            logger.error(`${tag} ${hook} → handler ✗ (${handlerElapsed()}): ${describeErr(err)}`);
            throw err;
          }
        };

        try {
          const result = await (original as (req: any, h: typeof tracedHandler) => any)(
            request,
            tracedHandler,
          );
          logger.info(`${tag} ${hook} ◀ exit (${elapsed()})`);
          return result;
        } catch (err) {
          logger.error(`${tag} ${hook} ✗ error (${elapsed()}): ${describeErr(err)}`);
          throw err;
        }
      };
      continue;
    }

    // 普通生命周期 hook: (state, runtime) => result | Promise<result>
    decorated[hook] = async function wrappedLifecycleHook(state: any, runtime: any) {
      const elapsed = startTimer();
      logger.info(`${tag} ${hook} ▶ enter`);
      try {
        const result = await (original as (s: any, r: any) => any | Promise<any>)(state, runtime);
        logger.info(`${tag} ${hook} ◀ exit (${elapsed()})`);
        return result;
      } catch (err) {
        logger.error(`${tag} ${hook} ✗ error (${elapsed()}): ${describeErr(err)}`);
        throw err;
      }
    };
  }

  // 通过通用对象重新还原为原中间件的强类型 M（hook 形态完全一致）
  return decorated as unknown as M;
}

/** 批量装饰，保持顺序与引用稳定（每个 mw 都被替换为新对象）。 */
export function withCallLogAll<M extends AgentMiddleware>(
  middlewares: readonly M[],
  options?: WithCallLogOptions,
): M[] {
  return middlewares.map((m) => withCallLog(m, options));
}
