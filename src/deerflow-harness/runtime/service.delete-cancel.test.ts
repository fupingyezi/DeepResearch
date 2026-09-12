import { describe, expect, it, vi } from 'vitest';
import type { BaseCheckpointSaver } from '@langchain/langgraph';

import type { DeerFlowClient } from '../client';
import type { RunStore } from '../persistence/runs';
import type { ThreadMetaStore } from '../persistence/thread-meta';

import { createThreadService } from './service';
import { ClientAgentEventType, createClientAgentEvent } from './sse/client-event';

/**
 * run 取消语义的锁定 —— 三条路径共用同一套「abort signal + 等收尾」机制：
 *   1. deleteThread：删对话时取消在跑的 run，等它停笔后再删 meta / checkpoint；
 *   2. cancelRun：用户点「停止」，不等收尾（交互要快），run 自己走取消收尾；
 *   3. submitRun 抢占：同一 thread 只允许一个 run，新的会取消上一个未结束的
 *      （两个 run 并发写同一份 checkpoint 会交错）。
 *
 * 关键约束：被取消的 run 记 failed + 'cancelled' 文案，**不能**记成 succeeded ——
 * DeerFlowClient 会吞掉 abort 异常后正常 return，执行体必须显式看 signal。
 */

const THREAD_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const USER_ID = 'user-1';

interface RunRow {
  status: string;
  error: string | null;
}

function makeHarness(mode: 'hang-until-abort' | 'complete' = 'hang-until-abort') {
  const threadRows = new Map<string, Record<string, unknown>>();
  const runRows = new Map<string, RunRow>();
  const deletedThreads: string[] = [];
  const checkpointDeletes: string[] = [];
  /** 每次流被 abort 时记录的 reason（取消原因文案） */
  const abortReasons: unknown[] = [];
  let startedCount = 0;
  const startWaiters: { n: number; resolve: () => void }[] = [];

  const threads = {
    async get(thread_id: string) {
      return threadRows.get(thread_id) ?? null;
    },
    async create(input: Record<string, unknown>) {
      const row = {
        ...input,
        status: 'idle',
        metadata: {},
        created_at: '2026-09-12T00:00:00.000Z',
        updated_at: '2026-09-12T00:00:00.000Z',
      };
      threadRows.set(String(input.thread_id), row);
      return row;
    },
    async updateStatus(thread_id: string, status: string) {
      const row = threadRows.get(thread_id);
      if (row) row.status = status;
    },
    async delete(thread_id: string) {
      deletedThreads.push(thread_id);
      threadRows.delete(thread_id);
    },
    async search() {
      return [];
    },
  };

  const runs: RunStore = {
    async create(input) {
      runRows.set(input.run_id, { status: 'pending', error: null });
      return input as never;
    },
    async setStatus(run_id: string, status: string, error?: string | null) {
      const row = runRows.get(run_id);
      if (row) {
        row.status = status;
        row.error = error ?? null;
      }
    },
    async get(run_id: string) {
      return (runRows.get(run_id) ?? null) as never;
    },
    async listByThread() {
      return [];
    },
  };

  // 假的 agent 流：复刻真实 DeerFlowClient 的关键行为 —— abort 时抛出，但在自己的
  // catch 里吞掉后正常 return（取消路径正因如此才必须显式判 signal.aborted）。
  const client = {
    async *stream(
      _message: string,
      _threadId?: string,
      _metadata?: unknown,
      _attachments?: unknown,
      signal?: AbortSignal,
    ) {
      yield createClientAgentEvent(ClientAgentEventType.STREAM_CHUNK, 'lead', { text: 'hi' });
      startedCount += 1;
      for (const waiter of [...startWaiters]) {
        if (startedCount >= waiter.n) {
          waiter.resolve();
          startWaiters.splice(startWaiters.indexOf(waiter), 1);
        }
      }

      if (mode === 'complete') return;
      if (signal?.aborted) {
        // 排队期间就被取消：真实 graph 会立刻抛 Abort，不会启动
        abortReasons.push(signal.reason);
        return;
      }
      try {
        await new Promise((_, reject) => {
          signal?.addEventListener('abort', () => {
            abortReasons.push(signal.reason);
            reject(new Error('Abort'));
          });
        });
      } catch {
        // 与 DeerFlowClient 的 catch 一致：吞掉，正常结束生成器
      }
    },
  };

  const checkpointer = {
    async deleteThread(threadId: string) {
      checkpointDeletes.push(threadId);
    },
  };

  const service = createThreadService({
    client: client as unknown as DeerFlowClient,
    checkpointer: checkpointer as unknown as BaseCheckpointSaver,
    threads: threads as unknown as ThreadMetaStore,
    runs,
  });

  return {
    service,
    runRows,
    threadRows,
    deletedThreads,
    checkpointDeletes,
    abortReasons,
    /** 等第 n 条流真正开始消费 */
    waitForStart(n: number) {
      return new Promise<void>((resolve) => {
        if (startedCount >= n) {
          resolve();
          return;
        }
        startWaiters.push({ n, resolve });
      });
    },
    async createThread() {
      await service.createThread({
        thread_id: THREAD_ID,
        user_id: USER_ID,
        display_name: 't',
      });
    },
  };
}

const reasonText = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason ?? '');

describe('deleteThread → 取消在跑的 run', () => {
  it('取消并等 run 收尾后再删：run 记 failed(cancelled)，不是 succeeded', async () => {
    const h = makeHarness();
    await h.createThread();

    const { run_id } = await h.service.submitRun({
      thread_id: THREAD_ID,
      user_id: USER_ID,
      input: 'hi',
    });

    await h.waitForStart(1);
    await h.service.deleteThread({ thread_id: THREAD_ID, user_id: USER_ID });

    expect(h.abortReasons.map(reasonText)).toEqual([expect.stringContaining('thread deleted')]);
    expect(h.runRows.get(run_id)?.status).toBe('failed');
    expect(String(h.runRows.get(run_id)?.error)).toContain('cancelled');
    expect(h.deletedThreads).toEqual([THREAD_ID]);
    // 顺序保证：清理 checkpoint 发生在 run 收尾之后
    expect(h.checkpointDeletes).toEqual([THREAD_ID]);
    expect(h.threadRows.has(THREAD_ID)).toBe(false);
  });

  it('没有在跑的 run 时：deleteThread 照常清理，不阻塞', async () => {
    const h = makeHarness();
    await h.createThread();

    await h.service.deleteThread({ thread_id: THREAD_ID, user_id: USER_ID });

    expect(h.deletedThreads).toEqual([THREAD_ID]);
    expect(h.checkpointDeletes).toEqual([THREAD_ID]);
  });

  it('正常跑完的 run 仍记 succeeded、thread 回 idle（取消改造没伤到 happy path）', async () => {
    const h = makeHarness('complete');
    await h.createThread();

    const { run_id } = await h.service.submitRun({
      thread_id: THREAD_ID,
      user_id: USER_ID,
      input: 'hi',
    });

    await h.waitForStart(1);
    await vi.waitFor(() => {
      expect(h.runRows.get(run_id)?.status).toBe('succeeded');
    });
    expect(h.threadRows.get(THREAD_ID)?.status).toBe('idle');
  });
});

describe('cancelRun（用户点停止）', () => {
  it('取消该 thread 在跑的 run，返回取消数，run 记 failed(stopped by user)', async () => {
    const h = makeHarness();
    await h.createThread();
    const { run_id } = await h.service.submitRun({
      thread_id: THREAD_ID,
      user_id: USER_ID,
      input: 'hi',
    });
    await h.waitForStart(1);

    const res = await h.service.cancelRun({ thread_id: THREAD_ID, user_id: USER_ID });

    expect(res.cancelled).toBe(1);
    await vi.waitFor(() => {
      expect(h.runRows.get(run_id)?.status).toBe('failed');
    });
    expect(String(h.runRows.get(run_id)?.error)).toContain('stopped by user');
    expect(h.threadRows.get(THREAD_ID)?.status).toBe('idle');
    // 取消 ≠ 删除：thread 与 checkpoint 都还在
    expect(h.deletedThreads).toEqual([]);
    expect(h.checkpointDeletes).toEqual([]);
  });

  it('没有在跑的 run：返回 0，不抛错（停止按钮幂等）', async () => {
    const h = makeHarness();
    await h.createThread();

    await expect(h.service.cancelRun({ thread_id: THREAD_ID, user_id: USER_ID })).resolves.toEqual({
      cancelled: 0,
    });
  });

  it('thread 不存在：抛 NOT_FOUND（路由把它翻成 cancelled: 0）', async () => {
    const h = makeHarness();
    await expect(
      h.service.cancelRun({ thread_id: THREAD_ID, user_id: USER_ID }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('submitRun 抢占：同一 thread 只允许一个 run', () => {
  it('再发一条会先取消上一个未结束的 run，新 run 正常运行', async () => {
    const h = makeHarness();
    await h.createThread();

    const first = await h.service.submitRun({
      thread_id: THREAD_ID,
      user_id: USER_ID,
      input: 'first',
    });
    await h.waitForStart(1);

    const second = await h.service.submitRun({
      thread_id: THREAD_ID,
      user_id: USER_ID,
      input: 'second',
    });
    await h.waitForStart(2);

    expect(h.abortReasons.map(reasonText)).toEqual([expect.stringContaining('superseded')]);
    expect(h.runRows.get(first.run_id)?.status).toBe('failed');
    expect(String(h.runRows.get(first.run_id)?.error)).toContain('superseded');
    // 新 run 不受影响（仍停在 running：假流的 hang 模式）
    expect(h.runRows.get(second.run_id)?.status).toBe('running');

    await h.service.cancelRun({ thread_id: THREAD_ID, user_id: USER_ID });
  });
});
