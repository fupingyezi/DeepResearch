/**
 * SandboxProvider：沙箱生命周期管理契约（获取 / 取回 / 标记空闲 / 心跳 / 释放）。
 *
 * 进程级单例工厂 getSandboxProvider() 定义在 provider-factory.ts，按 env 选择
 * 以保持「基类 → 实现」单向依赖、避免循环引用。
 *
 * 生命周期语义（供多对话并行编排）：
 * - acquire：run/agent 开始时获取（幂等复用），引用计数 +1。
 * - markIdle：run/agent 结束时（sandbox-middleware.afterAgent）调用，引用计数 -1；
 *   归零的容器交由空闲回收器按 idleTimeout 统一回收，而非立即删除。
 * - heartbeat：命令执行时刷新活跃时间，避免执行中的长任务被误回收。
 * - release：显式销毁（如 deleteThread）时停止并删除容器。
 *
 * markIdle / heartbeat 默认 no-op：LocalSandbox 为单例复用、无容器生命周期，
 * 无需实现；仅 Docker 后端覆盖以驱动回收与监控。
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
   * 按 threadId 显式销毁沙箱（如 deleteThread 时）。默认 no-op：无容器生命周期的
   * 后端（Local）无需处理；Docker 覆盖为停止删除对应容器并清理协调登记。
   */
  releaseByThreadId(_threadId: string): void {
    // 无容器生命周期的后端无需处理。
  }

  /**
   * 标记 run/agent 层开始持有该沙箱（引用计数 +1）。与 markIdle 成对，由
   * sandbox-middleware 的 beforeAgent/afterAgent 驱动，保证 refCount 反映「正在
   * 使用容器的 agent 层数」，不受工具层惰性 acquire 影响。默认 no-op。
   */
  retain(_sandboxId: string): void {
    // 无容器生命周期的后端（Local）无需处理。
  }

  /**
   * 标记沙箱进入空闲（引用计数 -1）。归零后交由后端的空闲回收器统一回收，
   * 不立即销毁，以便同一 thread 的后续 run 复用容器（吸收冷启动）。默认 no-op。
   */
  markIdle(_sandboxId: string): void {
    // 无容器生命周期的后端（Local）无需处理。
  }

  /** 刷新沙箱活跃时间，防执行中的长任务被空闲回收误删。默认 no-op。 */
  heartbeat(_sandboxId: string): void {
    // 无容器生命周期的后端（Local）无需处理。
  }

  /**
   * 该后端的命令执行是否构成安全隔离边界。
   * 决定 bash 工具是否需要 host-bash 门控：宿主直连执行（Local）非隔离，返回 false；
   * 容器等内核级隔离（Docker）返回 true。默认按非隔离处理，最安全。
   */
  isSecureIsolation(): boolean {
    return false;
  }
}
