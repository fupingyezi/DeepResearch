/**
 * 僵尸 run 回收：启动对账，把「PG 里仍 running 但 owner 进程已死」的 run 修正为
 * failed，并把 thread 状态带出 running（用户在刷新时看到真实终态而非永远转圈）。
 *
 * 判死依据：跨进程登记表 owner 键的存活——执行体心跳持续续租该键（键存活 =
 * owner 存活），owner 崩溃（kill -9 / 进程退出）后键在死亡窗口内到期，ownerOf
 * 返回 null。进程内登记表没有跨进程死亡语义（owner 即本进程，进程没了登记也
 * 没了），isDistributed() 为 false 时整体跳过。
 *
 * 误判防护：
 * - 低于 minAge 的 run 视为刚启动——「status 置 running」到「登记落地」之间是
 *   毫秒级窗口（owner 侧 Redis 慢时更长），留一个心跳窗口的缓冲再判死
 * - 抢占时旧 owner 崩溃会留下「旧 run 残留 running + 新 run 正在跑」的组合：
 *   只有线程最新 run 被回收时才把 thread 状态带向 error，不覆盖新 run 的 running
 *
 * 回收只写 runs / threads_meta 的终态（共享真相源），不清理 Redis 侧残留——
 * owner 键已随存活 TTL 到期，thread running 索引条目由 listByThread 的 Hash
 * 过滤兜底。
 */

import type { RunStore } from '../../persistence/runs';
import type { ThreadMetaStore } from '../../persistence/thread-meta';
import type { RunRegistry } from '../coordination/contracts';
import { HEARTBEAT_INTERVAL_MS } from './liveness';

const LOG = '[zombie-reconciler]';

/** 回收文案：RunStatus 枚举无 cancelled 值，与取消路径同规复用 failed + 文案。 */
export const ZOMBIE_ERROR = 'cancelled: process died';

/** 判死最小年龄：一个心跳窗口，覆盖「置 running → 登记落地」的窗口。 */
const ZOMBIE_MIN_AGE_MS = HEARTBEAT_INTERVAL_MS;

/** 单轮扫描上限：僵尸是异常残留，正常远达不到这个量级。 */
const SCAN_LIMIT = 500;

export interface ZombieReconcileDeps {
  runs: Pick<RunStore, 'listByStatus' | 'listByThread' | 'setStatus'>;
  threads: Pick<ThreadMetaStore, 'updateStatus'>;
  registry: Pick<RunRegistry, 'ownerOf' | 'isDistributed' | 'ready'>;
  /**
   * 归还被回收 run 的全局并发名额（跨进程槽键释放）：kill -9 的 run 走不到
   * finally，计数留在 Redis 里，不归还则全局名额随僵尸永久流失。可选——
   * 不传时只修状态不还名额。
   */
  releaseRunSlot?: (runId: string) => Promise<void>;
  /** 当前时间源：测试注入。 */
  now?: () => number;
  /** 判死最小年龄覆盖：测试注入极小值观察回收路径。 */
  minAgeMs?: number;
}

export async function reconcileZombieRuns(deps: ZombieReconcileDeps): Promise<{ reaped: number }> {
  const now = deps.now ?? Date.now;
  const minAgeMs = deps.minAgeMs ?? ZOMBIE_MIN_AGE_MS;
  await deps.registry.ready();
  if (!deps.registry.isDistributed()) return { reaped: 0 };

  const running = await deps.runs.listByStatus('running', { limit: SCAN_LIMIT });
  let reaped = 0;
  for (const run of running) {
    try {
      if (now() - Date.parse(run.created_at) < minAgeMs) continue;
      if (await deps.registry.ownerOf(run.run_id)) continue;

      // 线程状态只随「最新 run」走：旧 run 残留（抢占时 owner 崩溃）不覆盖新 run
      const newest = await deps.runs.listByThread(run.thread_id, { limit: 1 });
      if (newest[0]?.run_id === run.run_id) {
        await deps.threads.updateStatus(run.thread_id, 'error', { user_id: null });
      }
      await deps.runs.setStatus(run.run_id, 'failed', ZOMBIE_ERROR);
      // 名额归还在状态落库之后：先确保 run 已判死，再让名额可被新 run 占用。
      // 释放本身幂等（槽键 DEL 一次即失效），失败只告警——名额可由下轮对账补还
      try {
        await deps.releaseRunSlot?.(run.run_id);
      } catch (e) {
        console.warn(`${LOG} release slot failed run_id=${run.run_id}:`, (e as Error)?.message);
      }
      reaped += 1;
      console.info(`${LOG} reaped zombie run thread_id=${run.thread_id} run_id=${run.run_id}`);
    } catch (e) {
      // 单条失败不阻断整体对账：下轮对账（或下次启动）再试
      console.warn(`${LOG} reap failed run_id=${run.run_id}:`, (e as Error)?.message);
    }
  }
  if (reaped > 0) console.info(`${LOG} reaped ${reaped} zombie run(s)`);
  return { reaped };
}
