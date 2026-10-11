/**
 * config.yaml `extensions.middlewares` 的模块加载（对齐 deer-flow 2.0 PR #3964）。
 *
 * 路径形态：相对路径 / 绝对路径 / 裸包名（按 baseDir 的 node_modules 解析）。
 * 加载：先 CJS require，失败回落 ESM dynamic import（createRequire 锚点取
 * process.cwd() —— 不实际加载锚点文件，只为拿 CJS 语义的 require/resolve，
 * 且 cwd 在 CJS/ESM 双运行时下都可用）。
 *
 * 导出形态归一（模块只需提供其一）：
 * - 默认导出 / 命名导出 `middleware`：中间件实例、或数组、或工厂函数（可 async，
 *   返回值同上）
 * - 命名导出 `middlewares`：数组
 * - CJS `module.exports = X` 直出（无 default 键，整个 exports 对象即导出值）
 *
 * 失败大声报错：extensions 是装配注入面，静默跳过等于「配了但没生效」。
 * Next standalone 运行期不含源码树——TS 源码 / 项目内未打包模块 require 会
 * 失败，此时错误信息里带部署提示（中间件必须是 node_modules 包或已编译产物）。
 * 变更需重启：启动时只 require 一次（registerExtraMiddleware 后 agent 缓存键
 * 里的 extra-middlewares 签名随之固定）。
 */

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentMiddleware } from 'langchain';

import { registerExtraMiddleware } from '@deerflow-harness';

const nodeRequire = createRequire(path.join(process.cwd(), '__deerflow_noop__.js'));

function resolveSpecifier(specifier: string, baseDir: string): string {
  try {
    if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
      // require.resolve 补扩展名（.js/.json/.node）；相对路径以 baseDir 为锚
      return nodeRequire.resolve(path.resolve(baseDir, specifier));
    }
    return nodeRequire.resolve(specifier, { paths: [baseDir] });
  } catch (e) {
    throw new Error(
      `[middleware-loader] cannot resolve middleware module '${specifier}' from ${baseDir}: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** 中间件实例的宽松判别：createMiddleware 产物是带 name/hook 的对象。 */
function isMiddlewareInstance(value: unknown): value is AgentMiddleware {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}

async function normalizeMiddlewareExport(
  mod: unknown,
  specifier: string,
): Promise<AgentMiddleware[]> {
  const m = (mod ?? {}) as Record<string, unknown>;
  let value: unknown;
  if (m.default !== undefined) {
    value = m.default;
  } else if (m.middleware !== undefined) {
    value = m.middleware;
  } else if (m.middlewares !== undefined) {
    value = m.middlewares;
  } else if (isMiddlewareInstance(mod) || Array.isArray(mod) || typeof mod === 'function') {
    // CJS `module.exports = X` 无 default 键：整个 exports 对象即导出值
    // （无转译手写模块的默认导出写法）；不满足实例/数组/工厂形态才判为无效
    value = mod;
  } else {
    throw new Error(
      `[middleware-loader] module '${specifier}' exports no middleware ` +
        `(expected default / middleware / middlewares)`,
    );
  }
  // 函数 = 工厂（可 async）；中间件实例是对象形态（isMiddlewareInstance 运行期
  // 判别），两者互斥。不用 guard 否定判工厂：AgentMiddleware 接口结构上只要求
  // name，Function 可赋值给它，否定收窄会得到 never
  let produced: unknown = value;
  if (typeof value === 'function') {
    produced = await (value as () => unknown)();
  }
  const list = Array.isArray(produced) ? produced : [produced];
  if (list.length === 0) {
    throw new Error(
      `[middleware-loader] module '${specifier}' resolved to an empty middleware list`,
    );
  }
  return list as AgentMiddleware[];
}

/** 加载单个中间件模块，归一为中间件实例数组。 */
export async function loadMiddlewareModule(
  specifier: string,
  baseDir: string,
): Promise<AgentMiddleware[]> {
  const resolved = resolveSpecifier(specifier, baseDir);
  let mod: unknown;
  try {
    mod = nodeRequire(resolved);
  } catch {
    try {
      mod = await import(pathToFileURL(resolved).href);
    } catch (e2) {
      throw new Error(
        `[middleware-loader] failed to load middleware module '${specifier}' ` +
          `(resolved: ${resolved}): ${e2 instanceof Error ? e2.message : String(e2)}. ` +
          `Next standalone 部署的运行期不含源码树——中间件模块必须是 node_modules 包或已编译产物`,
      );
    }
  }
  return normalizeMiddlewareExport(mod, specifier);
}

/** 把 YAML 声明的中间件全部注册进 harness 注册表（顺序 = 声明序，scope 默认 both）。 */
export async function loadConfiguredExtraMiddlewares(
  specs: string[],
  baseDir: string,
): Promise<void> {
  for (const spec of specs) {
    const list = await loadMiddlewareModule(spec, baseDir);
    for (const middleware of list) {
      registerExtraMiddleware(middleware);
    }
  }
}
