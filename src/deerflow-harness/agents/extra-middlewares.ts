import type { AgentMiddleware } from 'langchain';

import { resolveMiddlewareAnchor, anchorDisplayName, middlewareDisplayName } from './features';

/**
 * 自定义中间件的进程级注册表：注册的中间件会进入真实装配链——
 * `DeerFlowClient.ensureAgent()`（lead）与 `SubagentExecutor`（subagent）
 * 构建 agent 时经 `extraMiddlewares` 传入 `assembleFromFeatures`。
 *
 * 用法：
 * ```ts
 * import { Next, registerExtraMiddleware } from '@/deerflow-harness';
 * import { toolErrorHandlingMiddleware } from '@/deerflow-harness/agents/middlewares';
 *
 * const audit = createMiddleware({ name: 'AuditMiddleware', ...hooks });
 * registerExtraMiddleware(audit);                                  // lead + subagent
 * registerExtraMiddleware(audit, { scope: 'lead' });               // 仅 lead
 * // 带锚点：插到 ToolErrorHandlingMiddleware 之后（实例锚点见 features.ts）
 * Object.assign(audit, { _nextAnchor: toolErrorHandlingMiddleware });
 * ```
 *
 * 语义与约束：
 * - **顺序 = 注册序**，落位规则同 `extraMiddlewares`（@Next/@Prev 锚点、
 *   无锚/未命中落链尾）。锚点只对内置链解析（快照语义，见 factory.ts
 *   `insertExtrasWithAnchors`）——锚另一个 extra 不生效。
 * - **锚点选常驻中间件**（ToolCallIntegrity / ToolErrorHandling /
 *   LoopDetection）：锚 feature 门控的中间件（如 MemoryMiddleware）在未开该
 *   feature 的链上（subagent 恒关 memory）会未命中 → 落尾 + 一次性告警。
 *   这是接受的降级：按链形态过滤会让注册表耦合装配逻辑。
 * - **同一实例重复注册为 no-op**（告警一次）：dev 下模块重求值不应造成
 *   双重挂载（hook 跑两遍、withCallLogAll 双层包裹）。
 * - **实例跨 agent 共享**：同一实例进 lead 与每次 subagent 构建，与内置
 *   中间件的单例风格一致——不得在实例上挂 per-agent 状态，需要时用
 *   beforeAgent 写 state。
 * - 注册应在 service import graph 内完成（如 `_service.ts` 的 build()）；
 *   在其它模块实例里注册（dev HMR 分裂场景）会写入另一个注册表实例，
 *   静默不生效。生产单次打包无此问题。
 * - `createBaseAgent` 显式传 `middlewares` 的调用方不走 features 装配路径，
 *   天然绕过本注册表。
 */

export type MiddlewareScope = 'lead' | 'subagent' | 'both';

export interface RegisterExtraMiddlewareOptions {
  /** 生效范围，默认 'both'（lead 与 subagent 链都挂载）。 */
  scope?: MiddlewareScope;
}

interface RegistryEntry {
  middleware: AgentMiddleware;
  scope: MiddlewareScope;
}

/** scope → 该范围感知到的注册次数（'both' 对两个 scope 各计一次）。 */
const mutationCount: Record<'lead' | 'subagent', number> = { lead: 0, subagent: 0 };
const entries: RegistryEntry[] = [];
const warnedDuplicates = new WeakSet<object>();

/** 注册一个自定义中间件；同一实例重复注册为 no-op（告警一次）。 */
export function registerExtraMiddleware(
  middleware: AgentMiddleware,
  options: RegisterExtraMiddlewareOptions = {},
): void {
  const scope = options.scope ?? 'both';
  if (warnedDuplicates.has(middleware)) {
    // 同实例已在册：dev HMR 下 registrar 重求值会走到这里，静默跳过会让人
    // 误以为注册成功，重复挂载则 hook 跑两遍 —— 必须出声但不重复出声。
    console.warn(`[mw] 重复注册：${middlewareDisplayName(middleware)} 已在注册表中，本次忽略`);
    return;
  }
  warnedDuplicates.add(middleware);
  for (const s of scope === 'both' ? (['lead', 'subagent'] as const) : [scope]) {
    mutationCount[s] += 1;
  }
  entries.push({ middleware, scope });
}

/** 读取指定 scope 的注册中间件（注册序）。返回新数组，实例保持同一。 */
export function getExtraMiddlewares(scope: 'lead' | 'subagent'): AgentMiddleware[] {
  return entries.filter((e) => e.scope === scope || e.scope === 'both').map((e) => e.middleware);
}

/**
 * 指定 scope 的注册签名（稳定字符串），折入 DeerFlowClient 的 agent 缓存键：
 * 注册变化 → 签名变化 → 缓存失效重建。与 MCP/skill 签名同一惰性失效契约。
 *
 * 编码 = 计数器 + 逐条描述符：计数器保证结构相同的两条注册（如同名实例
 * 先删后加）也能区分；描述符（中间件名/锚点名/方向）让签名可 diff。
 * 仅进程内存缓存消费，无需跨进程稳定——生产构建压缩类名不影响正确性。
 */
export function getExtraMiddlewaresSignature(scope: 'lead' | 'subagent'): string {
  const descriptors = entries
    .filter((e) => e.scope === scope || e.scope === 'both')
    .map((e) => {
      const resolved = resolveMiddlewareAnchor(e.middleware);
      return [
        middlewareDisplayName(e.middleware),
        resolved ? anchorDisplayName(resolved.anchor) : null,
        resolved?.side ?? null,
      ];
    });
  return JSON.stringify(['extra-mw', scope, mutationCount[scope], descriptors]);
}

/** 清空注册表（测试隔离用）。 */
export function resetExtraMiddlewares(): void {
  entries.length = 0;
  mutationCount.lead = 0;
  mutationCount.subagent = 0;
}
