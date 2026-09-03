/**
 * SandboxProvider：沙箱生命周期管理契约（获取 / 取回 / 释放）。
 *
 * 进程级单例工厂 getSandboxProvider() 定义在 provider-factory.ts，按 env 选择
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

  /**
   * 该后端的命令执行是否构成安全隔离边界。
   * 决定 bash 工具是否需要 host-bash 门控：宿主直连执行（Local）非隔离，返回 false；
   * 容器等内核级隔离（Docker）返回 true。默认按非隔离处理，最安全。
   */
  isSecureIsolation(): boolean {
    return false;
  }
}
