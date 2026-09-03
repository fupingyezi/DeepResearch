/**
 * RunConcurrencyGate —— run 级并发闸门（双层背压的「run 级」一层）。
 *
 * 背景：submitRun 是 fire-and-forget，此前无任何背压，N 个对话并发即 N 个执行体
 * 同时消费 LLM 流与容器命令，易过载。本闸门在执行体消费流之前限制全局并发 run 数。
 *
 * 双层协调：
 * - 本进程：信号量 + FIFO 队列，保证本进程内公平排队（先到先放行）。
 * - 跨进程（单机多进程 / PM2）：经沙箱协调模块的 runs:count 原子占位做全局上限；
 *   Redis 不可用时协调模块自动降级进程内，与本地信号量语义合流。
 *
 * 排队可观测：超限进入等待前触发 onQueued 回调，调用方据此回传「排队中」状态帧，
 * 对话仍可先思考，执行体延迟启动，符合「立即返回 run_id」的不变量。
 */

import { getSandboxCoordinator } from '../sandbox/docker/docker-coordinator';

/** 跨进程占位失败时的本地轮询重试间隔（毫秒）。 */
const RESERVE_RETRY_INTERVAL_MS = 500;

function getMaxConcurrentRuns(): number {
  const raw = process.env.DEERFLOW_MAX_CONCURRENT_RUNS;
  const parsed = raw ? Number.parseInt(raw.trim(), 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16;
}

/** 释放句柄：执行体结束（finally）时调用一次，归还名额并唤醒队首。 */
export type RunReleaseHandle = () => void;

interface Waiter {
  resolve: () => void;
}

class RunConcurrencyGate {
  private active = 0;
  private readonly queue: Waiter[] = [];

  /**
   * 获取一个 run 名额。若达上限则进入 FIFO 队列等待；每次等待前触发一次 onQueued。
   * 返回释放句柄，调用方必须在 finally 中调用以防名额泄漏。
   */
  async acquire(onQueued?: () => void): Promise<RunReleaseHandle> {
    const maxRuns = getMaxConcurrentRuns();
    let queuedNotified = false;

    // 先过本进程信号量（FIFO 公平），再过跨进程全局上限。
    while (this.active >= maxRuns) {
      if (!queuedNotified) {
        queuedNotified = true;
        safeInvoke(onQueued);
      }
      await this.waitInQueue();
    }
    this.active += 1;

    // 跨进程占位：失败说明其它进程已占满全局名额，轮询等待放行。
    const coordinator = getSandboxCoordinator();
    // 全局上限按「本进程上限 × 进程数」不可知，故用本进程 maxRuns 作为每进程配额的
    // 上界近似；跨进程 runs:count 以相同 maxRuns 作为全局闸门（部署时按需调大）。
    while (!(await coordinator.tryReserveRun(maxRuns))) {
      if (!queuedNotified) {
        queuedNotified = true;
        safeInvoke(onQueued);
      }
      await delay(RESERVE_RETRY_INTERVAL_MS);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      void coordinator.releaseRun();
      this.dequeue();
    };
  }

  private waitInQueue(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push({ resolve });
    });
  }

  private dequeue(): void {
    const next = this.queue.shift();
    if (next) next.resolve();
  }
}

const gateSingleton = new RunConcurrencyGate();

/** 进程级单例闸门。 */
export function getRunConcurrencyGate(): RunConcurrencyGate {
  return gateSingleton;
}

function safeInvoke(fn?: () => void): void {
  if (!fn) return;
  try {
    fn();
  } catch {
    // 排队通知失败不应影响放行。
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
