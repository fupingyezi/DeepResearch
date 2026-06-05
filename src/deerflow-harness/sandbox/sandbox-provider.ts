/**
 * SandboxProvider：沙箱生命周期管理契约（获取 / 取回 / 释放）。
 *
 * 进程级单例工厂 getSandboxProvider() 定义在 local/local-sandbox-provider.ts，
 * 以保持「基类 → 实现」单向依赖、避免循环引用。
 */

import { Sandbox } from './sandbox';

export abstract class SandboxProvider {
  /** 获取（或复用）一个沙箱，返回其 id。 */
  abstract acquire(threadId?: string): string;

  /** 按 id 取回沙箱实例；不存在返回 null。 */
  abstract get(sandboxId: string): Sandbox | null;

  /** 释放沙箱（LocalSandbox 为单例复用，通常 no-op）。 */
  abstract release(sandboxId: string): void;
}
