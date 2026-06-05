import { createMiddleware } from 'langchain';

import { getContext } from '../../runtime/context';
import { getSandboxProvider } from '../../sandbox';
import type { SandboxState } from '../thread-state';

/**
 * SandboxMiddleware（基础设施 / features.sandbox）
 *
 * 职责：
 * - `beforeAgent` 阶段获取（或复用）一个沙箱，并把 `sandboxId` 写回
 *   `state.sandbox`，供后续 sandbox 工具读取。LocalSandbox 为单例复用，跨多轮
 *   会话不销毁，避免重复创建。
 *
 * 触发与幂等：
 * - `state.sandbox.sandboxId` 已存在则直接 return（同一 run 内重复进入不重复获取）。
 * - 必须能从 `getContext()` 拿到 `thread_id`；缺失时不报错，工具层会按需惰性初始化。
 *
 * 与 subagent 的关系：subagent 的 createBaseAgent 不传 features，不会跑本中间件；
 * sandbox 工具自身具备惰性初始化兜底，因此 subagent 仍可正常使用沙箱。
 */

interface SandboxMiddlewareState {
  sandbox?: SandboxState | null;
}

export const sandboxMiddleware = createMiddleware({
  name: 'SandboxMiddleware',
  beforeAgent: (state: SandboxMiddlewareState) => {
    if (state.sandbox && state.sandbox.sandboxId) return undefined;

    const threadId = getContext()?.thread_id;
    try {
      const sandboxId = getSandboxProvider().acquire(threadId);
      return { sandbox: { sandboxId } };
    } catch (e) {
      console.error('[sandboxMiddleware] beforeAgent acquire error:', e);
      return undefined;
    }
  },
});
