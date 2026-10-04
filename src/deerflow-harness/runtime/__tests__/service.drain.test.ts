import { describe, expect, it } from 'vitest';
import type { BaseCheckpointSaver } from '@langchain/langgraph';

import type { DeerFlowClient } from '../../client';
import type { RunStore } from '../../persistence/runs';
import type { ThreadMetaStore } from '../../persistence/thread-meta';

import { createThreadService } from '../service';
import { ClientAgentEventType, createClientAgentEvent } from '../sse/client-event';

/**
 * 优雅停机语义：draining 置位后拒绝新 run；beginShutdown 等待在跑 run 自然
 * 收尾，超时取消并等收尾落库 / END 落流；幂等复用同一 Promise。
 */

const THREAD_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const USER_ID = 'user-1';

interface HarnessOpts {
  /** 流在自结束后挂起多久（>0 表示 run 会跑这么久才自终）。缺省 0 = 立即结束。 */
  streamLifetimeMs?: number;
  /** true = 流一直挂起直到 abort（模拟长输出 / 卡住）。 */
  hangUntilAbort?: boolean;
}

function makeHarness(opts: HarnessOpts = {}) {
  const threadRows = new Map<string, Record<string, unknown>>();
  const runRows = new Map<string, { status: string; error: string | null }>();

  const threads = {
    async get(thread_id: string) {
      return threadRows.get(thread_id) ?? null;
    },
    async create(input: Record<string, unknown>) {
      const row = { ...input, status: 'idle', metadata: {}, created_at: '', updated_at: '' };
      threadRows.set(String(input.thread_id), row);
      return row;
    },
    async updateStatus(thread_id: string, status: string) {
      const row = threadRows.get(thread_id);
      if (row) row.status = status;
    },
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
      if (opts.hangUntilAbort) {
        await new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('Abort')));
        });
      } else {
        const ms = opts.streamLifetimeMs ?? 0;
        if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
      }
    },
  };

  const service = createThreadService({
    client: client as unknown as DeerFlowClient,
    checkpointer: { deleteThread: async () => {} } as unknown as BaseCheckpointSaver,
    threads: threads as unknown as ThreadMetaStore,
    runs,
    heartbeatIntervalMs: 60_000, // 心跳拉长，测试窗口内不产生干扰事件
  });

  return { service, runRows, threadRows };
}

const makeThread = async (h: ReturnType<typeof makeHarness>): Promise<void> => {
  await h.service.createThread({ thread_id: THREAD_ID, user_id: USER_ID, display_name: 't' });
};

describe('优雅停机（beginShutdown）', () => {
  it('draining 置位后 submitRun / resume 抛 SERVER_DRAINING', async () => {
    const h = makeHarness();
    await makeThread(h);
    await h.service.submitRun({ thread_id: THREAD_ID, user_id: USER_ID, input: 'hi' });

    const drain = h.service.beginShutdown(1000);
    await expect(
      h.service.submitRun({ thread_id: THREAD_ID, user_id: USER_ID, input: 'again' }),
    ).rejects.toMatchObject({ code: 'SERVER_DRAINING' });
    await expect(
      h.service.resume({ thread_id: THREAD_ID, user_id: USER_ID, decision: 'ok' }),
    ).rejects.toMatchObject({ code: 'SERVER_DRAINING' });
    await drain;
  });

  it('run 在等待窗口内自然收尾 → 不取消，run 落 succeeded，health 反映停机态', async () => {
    const h = makeHarness({ streamLifetimeMs: 60 });
    await makeThread(h);
    const { run_id } = await h.service.submitRun({
      thread_id: THREAD_ID,
      user_id: USER_ID,
      input: 'hi',
    });

    expect(await h.service.health()).toEqual({ distributed: false, draining: false });
    const result = await h.service.beginShutdown(2000);
    expect(result).toEqual({ cancelled: 0, pending: 0 });
    expect(h.runRows.get(run_id)?.status).toBe('succeeded');
    expect(await h.service.health()).toEqual({ distributed: false, draining: true });
  });

  it('等待窗口耗尽 → 取消在跑 run：落 failed（draining 文案）且 END 落流，pending=0', async () => {
    const h = makeHarness({ hangUntilAbort: true });
    await makeThread(h);
    const { run_id } = await h.service.submitRun({
      thread_id: THREAD_ID,
      user_id: USER_ID,
      input: 'hi',
    });

    const seen: ClientAgentEventType[] = [];
    const reading = (async () => {
      for await (const s of h.service.subscribe({ thread_id: THREAD_ID, run_id })) {
        seen.push(s.event.eventType);
      }
    })();

    const result = await h.service.beginShutdown(80);
    await reading;

    expect(result).toEqual({ cancelled: 1, pending: 0 });
    expect(h.runRows.get(run_id)?.status).toBe('failed');
    expect(h.runRows.get(run_id)?.error).toBe('cancelled: server draining');
    expect(h.threadRows.get(THREAD_ID)?.status).toBe('idle');
    // 被取消的 run 不额外发 ERROR 帧，但 END 必须落流（收尾帧）
    expect(seen[seen.length - 1]).toBe(ClientAgentEventType.END);
  });

  it('beginShutdown 幂等：重复调用复用同一 Promise 与结果', async () => {
    const h = makeHarness({ hangUntilAbort: true });
    await makeThread(h);
    await h.service.submitRun({ thread_id: THREAD_ID, user_id: USER_ID, input: 'hi' });

    const first = h.service.beginShutdown(40);
    const second = h.service.beginShutdown(40);
    expect(second).toBe(first);
    await expect(first).resolves.toEqual(await second);
  });
});
