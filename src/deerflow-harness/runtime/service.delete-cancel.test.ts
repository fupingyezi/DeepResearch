import { describe, expect, it, vi } from 'vitest';
import type { BaseCheckpointSaver } from '@langchain/langgraph';

import type { DeerFlowClient } from '../client';
import type { RunStore } from '../persistence/runs';
import type { ThreadMetaStore } from '../persistence/thread-meta';

import { createThreadService } from './service';
import { ClientAgentEventType, createClientAgentEvent } from './sse/client-event';

/**
 * 删除对话 → 取消该对话正在跑的 run 的行为锁定。
 *
 * 覆盖三条不变量：
 *   1. deleteThread 会 abort 在跑 run 的 signal，并等它收尾后再删 meta / checkpoint
 *      （否则 run 会把 checkpoint 又写回来）；
 *   2. 被取消的 run 记 failed + 'cancelled' 文案，**不能**被记成 succeeded ——
 *      DeerFlowClient 会吞掉 abort 异常后正常 return，所以执行体必须显式看 signal；
 *   3. 正常跑完仍然记 succeeded（改执行体不该伤到 happy path）。
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

  let notifyStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  let notifyAborted: (reason: unknown) => void = () => {};
  const aborted = new Promise<unknown>((resolve) => {
    notifyAborted = resolve;
  });
  const yielded: unknown[] = [];

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
  // catch 里吞掉后正常 return。取消路径正因如此才必须显式判 signal.aborted。
  const client = {
    async *stream(
      _message: string,
      _threadId?: string,
      _metadata?: unknown,
      _attachments?: unknown,
      signal?: AbortSignal,
    ) {
      yield createClientAgentEvent(ClientAgentEventType.STREAM_CHUNK, 'lead', { text: 'hi' });
      notifyStarted();
      if (mode === 'complete') {
        yielded.push('done');
        return;
      }
      try {
        await new Promise((_, reject) => {
          signal?.addEventListener('abort', () => {
            notifyAborted(signal.reason);
            reject(new Error('Abort'));
          });
        });
      } catch {
        // 与 DeerFlowClient 的 catch 一致：吞掉，正常结束生成器
      }
      yielded.push('done');
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
    started,
    aborted,
    runRows,
    deletedThreads,
    checkpointDeletes,
    threadRows,
  };
}

describe('deleteThread → 取消在跑的 run', () => {
  it('取消并等 run 收尾后再删：run 记 failed(cancelled)，不是 succeeded', async () => {
    const h = makeHarness();
    await h.service.createThread({ thread_id: THREAD_ID, user_id: USER_ID, display_name: 't' });

    const { run_id } = await h.service.submitRun({
      thread_id: THREAD_ID,
      user_id: USER_ID,
      input: 'hi',
    });

    await h.started; // 等执行体真正进入流消费
    await h.service.deleteThread({ thread_id: THREAD_ID, user_id: USER_ID });

    expect(await h.aborted).toBeTruthy(); // signal 被 abort，reason 是取消原因
    expect(h.runRows.get(run_id)?.status).toBe('failed');
    expect(String(h.runRows.get(run_id)?.error)).toContain('cancelled');
    expect(h.deletedThreads).toEqual([THREAD_ID]);
    // 顺序保证：清理 checkpoint 发生在 run 收尾之后
    expect(h.checkpointDeletes).toEqual([THREAD_ID]);
    expect(h.threadRows.has(THREAD_ID)).toBe(false);
  });

  it('没有在跑的 run 时：deleteThread 照常清理，不阻塞', async () => {
    const h = makeHarness();
    await h.service.createThread({ thread_id: THREAD_ID, user_id: USER_ID, display_name: 't' });

    await h.service.deleteThread({ thread_id: THREAD_ID, user_id: USER_ID });

    expect(h.deletedThreads).toEqual([THREAD_ID]);
    expect(h.checkpointDeletes).toEqual([THREAD_ID]);
  });

  it('正常跑完的 run 仍记 succeeded、thread 回 idle（取消改造没伤到 happy path）', async () => {
    const h = makeHarness('complete');
    await h.service.createThread({ thread_id: THREAD_ID, user_id: USER_ID, display_name: 't' });

    const { run_id } = await h.service.submitRun({
      thread_id: THREAD_ID,
      user_id: USER_ID,
      input: 'hi',
    });

    await h.started;
    await vi.waitFor(() => {
      expect(h.runRows.get(run_id)?.status).toBe('succeeded');
    });
    expect(h.threadRows.get(THREAD_ID)?.status).toBe('idle');
  });
});
