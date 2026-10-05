/**
 * 进程生命周期接线（Next 的 register 钩子，服务端启动时调用一次）：
 *
 * - 优雅停机：SIGTERM / SIGINT → beginShutdown（置 draining 停止接新 → 等待在跑
 *   run 自然收尾 → 超时取消并等收尾落库 / END 落流）→ 冲刷记忆更新队列 → 退出。
 *   第二次信号立即退出——drain 可能被卡死的收尾拖住，不无限等。
 *   前置不变量：进程必须以 NEXT_MANUAL_SIG_HANDLE=1 运行——否则 Next 自带的
 *   SIGTERM 清理（server.close → exit(0)）先于排水序列把进程直接退出
 * - 启动对账：启动时与 +60s 各跑一轮僵尸回收，把「owner 已死但仍 running」的 run
 *   修正为 failed（判死语义见 harness 的 zombie-reconciler）。第二轮覆盖启动时
 *   owner 键尚未到期的窗口
 *
 * threadService 在启动期初始化（建池 / 建 checkpointer）：停机与对账在无流量时同样可用。
 */

import { getMemoryQueue, type ThreadService } from '@/deerflow-harness';
import { getThreadService } from '@/server/wiring';

/** 记忆队列冲刷超时：挂起的 LLM 调用不能拖死退出，超时放弃本轮未落盘的记忆更新。 */
const MEMORY_FLUSH_TIMEOUT_MS = 10_000;

/** 第二轮对账延迟：覆盖「新进程启动时 owner 键尚未到期」的判死窗口。 */
const RECONCILE_SECOND_PASS_MS = 60_000;

/**
 * process.exit 会丢弃 stdout 管道里尚未冲刷的缓冲：排水日志写在退出前一刻，
 * 不加这一步，部署方（compose / 编排）把 stdout 导到文件时可能看不到
 * 「drain done」——滚动发布靠它确认实例已排水，必须写尽再退。
 */
function flushStdout(): Promise<void> {
  return new Promise((resolve) => {
    // 管道已断（EPIPE）也照常 resolve：目标已不存在，写尽与否无所谓
    process.stdout.write('', () => resolve());
  });
}

let installed = false;

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (installed) return;
  installed = true;

  const service = getThreadService().catch((error) => {
    console.error('[lifecycle] threadService init failed:', (error as Error)?.message);
    return null;
  });

  void runReconcilePasses(service);
  installShutdownHandlers(service);
}

async function runReconcilePasses(service: Promise<ThreadService | null>): Promise<void> {
  const svc = await service;
  if (!svc) return;
  const pass = async (): Promise<void> => {
    try {
      const { reaped } = await svc.reconcileZombieRuns();
      if (reaped > 0) console.info(`[lifecycle] zombie reconcile pass reaped=${reaped}`);
    } catch (error) {
      console.warn('[lifecycle] zombie reconcile failed:', (error as Error)?.message);
    }
  };
  await pass();
  setTimeout(() => void pass(), RECONCILE_SECOND_PASS_MS).unref?.();
}

function installShutdownHandlers(service: Promise<ThreadService | null>): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      console.warn(`[lifecycle] second ${signal}, exiting immediately`);
      process.exit(1);
    }
    shuttingDown = true;
    void (async () => {
      console.info(`[lifecycle] ${signal} received, draining`);
      try {
        const svc = await service;
        if (svc) {
          const { cancelled, pending } = await svc.beginShutdown();
          console.info(`[lifecycle] drain done cancelled=${cancelled} pending=${pending}`);
        }
        await Promise.race([
          getMemoryQueue().flush(),
          new Promise<void>((resolve) => setTimeout(resolve, MEMORY_FLUSH_TIMEOUT_MS)),
        ]);
      } catch (error) {
        console.warn('[lifecycle] shutdown error:', (error as Error)?.message);
      }
      await flushStdout();
      process.exit(0);
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
