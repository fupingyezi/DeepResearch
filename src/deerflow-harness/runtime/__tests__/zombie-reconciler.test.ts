import { describe, expect, it, vi } from 'vitest';

import type { Run, RunStatus } from '../../persistence/runs';
import { reconcileZombieRuns, ZOMBIE_ERROR, type ZombieReconcileDeps } from '../zombie-reconciler';

/**
 * 僵尸回收判定：只回收「running 且 owner 已死」的 run——owner 键存活即跳过；
 * 低于最小年龄的视为刚启动（登记落地窗口）跳过；线程状态只随最新 run 走，
 * 旧 run 残留（抢占时 owner 崩溃）不覆盖新 run 的 running。
 */

const now = 1_000_000;
const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();

const runRow = (runId: string, threadId: string, createdAgo: number): Run => ({
  run_id: runId,
  thread_id: threadId,
  assistant_id: 'lead',
  user_id: 'u1',
  status: 'running',
  input: 'hi',
  error: null,
  created_at: iso(createdAgo),
  updated_at: iso(createdAgo),
});

const running = (rows: Array<{ run_id: string; thread_id: string; createdAgo: number }>): Run[] =>
  rows.map((r) => runRow(r.run_id, r.thread_id, r.createdAgo));

interface ReconcileOpts {
  distributed?: boolean;
  ownerOf?: ZombieReconcileDeps['registry']['ownerOf'];
  running?: Run[];
  minAgeMs?: number;
}

function makeDeps(opts: ReconcileOpts) {
  const state = {
    runRows: new Map<string, { status: string; error: string | null }>(),
    threadRows: new Map<string, string>(),
    /** thread_id → 最新在前（listByThread 的顺序）的 run 列表 */
    newestOf: new Map<string, string[]>(),
  };

  const deps: ZombieReconcileDeps = {
    registry: {
      isDistributed: () => opts.distributed ?? true,
      ownerOf: opts.ownerOf ?? (async () => null),
    },
    runs: {
      listByStatus: async () => opts.running ?? [],
      listByThread: async (thread_id: string) =>
        (state.newestOf.get(thread_id) ?? []).map((id) => runRow(id, thread_id, 1)),
      setStatus: async (run_id: string, status: RunStatus, error?: string | null) => {
        state.runRows.set(run_id, { status, error: error ?? null });
      },
    },
    threads: {
      updateStatus: async (thread_id: string, status: string) => {
        state.threadRows.set(thread_id, status);
      },
    },
    now: () => now,
    minAgeMs: opts.minAgeMs,
  };
  return { deps, state };
}

describe('reconcileZombieRuns', () => {
  it('登记表非跨进程（进程内实现）→ 整体跳过，不扫描', async () => {
    const listByStatus = vi.fn();
    const { deps } = makeDeps({ distributed: false });
    deps.runs.listByStatus = listByStatus as never;
    expect(await reconcileZombieRuns(deps)).toEqual({ reaped: 0 });
    expect(listByStatus).not.toHaveBeenCalled();
  });

  it('owner 键存活（ownerOf 非空）→ 跳过，不回收', async () => {
    const { deps, state } = makeDeps({
      running: running([{ run_id: 'r1', thread_id: 't1', createdAgo: 120_000 }]),
      ownerOf: async () => ({ runId: 'r1', threadId: 't1', owner: 'p', startedAt: 1 }),
    });
    expect(await reconcileZombieRuns(deps)).toEqual({ reaped: 0 });
    expect(state.runRows.get('r1')).toBeUndefined();
  });

  it('owner 已死且 age 低于最小年龄 → 视为刚启动，跳过', async () => {
    const { deps } = makeDeps({
      running: running([{ run_id: 'r1', thread_id: 't1', createdAgo: 5_000 }]),
    });
    expect(await reconcileZombieRuns(deps)).toEqual({ reaped: 0 });
  });

  it('owner 已死且超龄 → run 落 failed（process died 文案），thread 落 error', async () => {
    const { deps, state } = makeDeps({
      running: running([{ run_id: 'r1', thread_id: 't1', createdAgo: 120_000 }]),
    });
    state.newestOf.set('t1', ['r1']);

    expect(await reconcileZombieRuns(deps)).toEqual({ reaped: 1 });
    expect(state.runRows.get('r1')).toEqual({ status: 'failed', error: ZOMBIE_ERROR });
    expect(state.threadRows.get('t1')).toBe('error');
  });

  it('僵尸不是线程最新 run（新 run 已接管）→ run 仍回收，thread 状态不动', async () => {
    const { deps, state } = makeDeps({
      running: running([{ run_id: 'old', thread_id: 't1', createdAgo: 300_000 }]),
    });
    state.newestOf.set('t1', ['new']);

    expect(await reconcileZombieRuns(deps)).toEqual({ reaped: 1 });
    expect(state.runRows.get('old')?.status).toBe('failed');
    expect(state.threadRows.get('t1')).toBeUndefined();
  });

  it('单条回收失败不阻断整体对账', async () => {
    const { deps, state } = makeDeps({
      running: running([
        { run_id: 'r1', thread_id: 't1', createdAgo: 120_000 },
        { run_id: 'r2', thread_id: 't2', createdAgo: 120_000 },
      ]),
    });
    state.newestOf.set('t1', ['r1']);
    state.newestOf.set('t2', ['r2']);
    const setStatus = deps.runs.setStatus.bind(deps.runs);
    deps.runs.setStatus = (run_id: string, status: RunStatus, error?: string | null) => {
      if (run_id === 'r1') return Promise.reject(new Error('pg down'));
      return setStatus(run_id, status, error);
    };

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await reconcileZombieRuns(deps)).toEqual({ reaped: 1 });
    expect(state.runRows.get('r1')).toBeUndefined();
    expect(state.runRows.get('r2')?.status).toBe('failed');
    warn.mockRestore();
  });
});
