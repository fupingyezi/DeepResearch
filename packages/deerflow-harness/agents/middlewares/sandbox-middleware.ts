import { createMiddleware } from 'langchain';

import { getContext } from '../../runtime/context';
import { getSandboxProvider } from '../../sandbox';
import type { SandboxState } from '../thread-state';

/**
 * SandboxMiddleware（基础设施 / features.sandbox）
 *
 * 职责：
 * - `beforeAgent`：获取（或复用）一个沙箱并 retain（引用计数 +1），把 `sandboxId`
 *   写回 `state.sandbox`，供后续 sandbox 工具读取。acquire 幂等（同一 thread 复用
 *   容器）；retain 每个 run 触发一次，与 afterAgent 的 markIdle 成对。
 * - `afterAgent`：一轮交互结束时对 `state.sandbox.sandboxId` 调用 provider.markIdle
 *   （引用计数 -1）。归零的容器交由 provider 空闲回收器按 idleTimeout 统一回收，
 *   而非立即删除——修复此前 release 无调用点导致的容器泄漏，同时保留同一 thread
 *   后续 run 的容器复用（吸收冷启动）。
 *
 * 引用计数不变式（refCount = 正在使用容器的 run/agent 层数）：
 * - 每个 run 的 beforeAgent retain(+1) 与 afterAgent markIdle(-1) 严格成对。
 * - 即使 resume 复用了 state 里已有的 sandboxId，beforeAgent 仍 retain（新 run 新持有）。
 * - 工具层（含 subagent）的惰性 acquire 只 touch 不增计数，故不破坏成对性。
 *
 * 触发与幂等：
 * - 必须能从 `getContext()` 拿到 `thread_id`；缺失时不报错，工具层会按需惰性初始化。
 *
 * 与 subagent 的关系：subagent 的 createBaseAgent 不传 features，不跑本中间件；
 * sandbox 工具自身具备惰性初始化兜底，其 acquire 命中同一 thread 容器复用（仅 touch），
 * refCount 由 lead 层的 before/after 覆盖整个 run（含 subagent）生命周期。
 */

interface SandboxMiddlewareState {
  sandbox?: SandboxState | null;
}

export const sandboxMiddleware = createMiddleware({
  name: 'SandboxMiddleware',
  beforeAgent: (state: SandboxMiddlewareState) => {
    const threadId = getContext()?.thread_id;
    try {
      const provider = getSandboxProvider();
      // 复用 state 里已有的 sandboxId（resume 场景），否则新建；无论哪种都 retain 一次。
      const sandboxId = state.sandbox?.sandboxId ?? provider.acquire(threadId);
      provider.retain(sandboxId);
      return { sandbox: { sandboxId } };
    } catch (e) {
      console.error('[sandboxMiddleware] beforeAgent acquire error:', e);
      return undefined;
    }
  },
  afterAgent: (state: SandboxMiddlewareState) => {
    const sandboxId = state.sandbox?.sandboxId;
    if (!sandboxId) return undefined;
    try {
      // 标记空闲（引用计数-1），不立即销毁；容器由空闲回收器统一回收。
      getSandboxProvider().markIdle(sandboxId);
    } catch (e) {
      console.error('[sandboxMiddleware] afterAgent markIdle error:', e);
    }
    return undefined;
  },
});
