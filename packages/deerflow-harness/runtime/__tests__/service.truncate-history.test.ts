import { describe, expect, it } from 'vitest';
import type { BaseCheckpointSaver } from '@langchain/langgraph';

import type { DeerFlowClient } from '../../client';
import type { RunStore } from '../../persistence/runs';
import type { ThreadMetaStore } from '../../persistence/thread-meta';

import { createThreadService } from '../service';
import { ClientAgentEventType, createClientAgentEvent } from '../sse/client-event';

/**
 * truncateHistory（recall / reEditCall 的 checkpoint 截断）语义锁定：
 * - 与 submitRun 同款入口：draining 拒绝、归属校验 NOT_FOUND；
 * - thread 锁内先取消在跑的 run 并等停笔，再截 checkpoint —— 顺序不能反，
 *   否则被取消的旧 run 收尾时会把刚删掉的消息写回 checkpoint。
 */

const THREAD_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const USER_ID = 'user-1';

function makeHarness(mode: 'idle' | 'hang-until-abort' = 'idle') {
  const threadRows = new Map<string, Record<string, unknown>>();
  const runRows = new Map<string, { status: string; error: string | null }>();
  /** 全局事件顺序（'abort' / 'truncate'），锁定「先取消停笔、后截 checkpoint」 */
  const order: string[] = [];
  let started = 0;
  const startWaiters: { resolve: () => void }[] = [];

  const threads = {
    async get(thread_id: string) {
      return threadRows.get(thread_id) ?? null;
    },
    async create(input: Record<string, unknown>) {
      const row = { ...input, status: 'idle', metadata: {}, created_at: '', updated_at: '' };
      threadRows.set(String(input.thread_id), row);
      return row;
    },
    async updateStatus() {},
    async delete() {},
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
    async listByStatus() {
      return [];
    },
  };

  const client = {
    async *stream(
      _message: string,
      _threadId?: string,
      _metadata?: unknown,
      _attachments?: unknown,
      signal?: AbortSignal,
    ) {
      yield createClientAgentEvent(ClientAgentEventType.STREAM_CHUNK, 'lead', { text: 'hi' });
      started += 1;
      for (const waiter of [...startWaiters]) {
        waiter.resolve();
        startWaiters.splice(startWaiters.indexOf(waiter), 1);
      }
      if (mode === 'hang-until-abort') {
        try {
          await new Promise((_, reject) => {
            signal?.addEventListener('abort', () => {
              order.push('abort');
              reject(new Error('Abort'));
            });
          });
        } catch {
          // 与 DeerFlowClient 一致：abort 异常在流内部被吞掉，执行体显式判 signal.aborted
        }
      }
    },
    async truncateHistoryBeforeLatestUserMessage() {
      order.push('truncate');
      return true;
    },
  };

  const service = createThreadService({
    client: client as unknown as DeerFlowClient,
    checkpointer: {} as unknown as BaseCheckpointSaver,
    threads: threads as unknown as ThreadMetaStore,
    runs,
  });

  return {
    service,
    runRows,
    order,
    createThread: () =>
      service.createThread({ thread_id: THREAD_ID, user_id: USER_ID, display_name: 't' }),
    waitForStart: () =>
      new Promise<void>((resolve) => {
        if (started > 0) {
          resolve();
          return;
        }
        startWaiters.push({ resolve });
      }),
  };
}

describe('truncateHistory', () => {
  it('thread 不存在 → NOT_FOUND，不碰 checkpoint', async () => {
    const h = makeHarness();
    await expect(
      h.service.truncateHistory({ thread_id: THREAD_ID, user_id: USER_ID }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.order).toEqual([]);
  });

  it('正常路径：锁内截 checkpoint，返回 truncated', async () => {
    const h = makeHarness();
    await h.createThread();
    await expect(
      h.service.truncateHistory({ thread_id: THREAD_ID, user_id: USER_ID }),
    ).resolves.toEqual({ truncated: true });
    expect(h.order).toEqual(['truncate']);
  });

  it('有 run 在跑：先取消并等收尾，再截 checkpoint（顺序不能反）', async () => {
    const h = makeHarness('hang-until-abort');
    await h.createThread();
    const { run_id } = await h.service.submitRun({
      thread_id: THREAD_ID,
      user_id: USER_ID,
      input: 'hi',
    });
    await h.waitForStart();

    await h.service.truncateHistory({ thread_id: THREAD_ID, user_id: USER_ID });

    expect(h.order).toEqual(['abort', 'truncate']);
    expect(h.runRows.get(run_id)?.status).toBe('failed');
    expect(String(h.runRows.get(run_id)?.error)).toContain('superseded');
  });

  it('draining 置位 → SERVER_DRAINING（截断是为新 run 铺路，停机期不该动历史）', async () => {
    const h = makeHarness();
    await h.createThread();
    void h.service.beginShutdown(1000);
    await expect(
      h.service.truncateHistory({ thread_id: THREAD_ID, user_id: USER_ID }),
    ).rejects.toMatchObject({ code: 'SERVER_DRAINING' });
    expect(h.order).toEqual([]);
  });
});
