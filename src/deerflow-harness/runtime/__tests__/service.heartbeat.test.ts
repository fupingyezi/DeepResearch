import { describe, expect, it } from 'vitest';
import type { BaseCheckpointSaver } from '@langchain/langgraph';

import type { DeerFlowClient } from '../../client';
import type { RunStore } from '../../persistence/runs';
import type { ThreadMetaStore } from '../../persistence/thread-meta';

import { createThreadService } from '../service';
import { ClientAgentEventType, createClientAgentEvent } from '../sse/client-event';

/**
 * run 存活心跳的接线：执行体运行期间按注入间隔持续发布 HEARTBEAT 事件（跨进程
 * 重连方凭它的停摆判定 owner 死亡），收尾后停止——晚到的心跳不得复活已释放的流。
 */

const THREAD_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const USER_ID = 'user-1';

function makeHarness(heartbeatIntervalMs: number) {
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
  };

  // 流产出首帧后挂起，直到 abort —— 让 run 维持 running 状态足够久以观察心跳
  const client = {
    async *stream(
      _message: string,
      _threadId?: string,
      _metadata?: unknown,
      _attachments?: unknown,
      signal?: AbortSignal,
    ) {
      yield createClientAgentEvent(ClientAgentEventType.STREAM_CHUNK, 'lead', { text: 'hi' });
      await new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('Abort')));
      });
    },
  };

  const service = createThreadService({
    client: client as unknown as DeerFlowClient,
    checkpointer: { deleteThread: async () => {} } as unknown as BaseCheckpointSaver,
    threads: threads as unknown as ThreadMetaStore,
    runs,
    heartbeatIntervalMs,
  });

  return { service, runRows };
}

describe('run 存活心跳', () => {
  it('运行期间持续发布 HEARTBEAT，run 收尾后停止', async () => {
    const h = makeHarness(25);
    await h.service.createThread({
      thread_id: THREAD_ID,
      user_id: USER_ID,
      display_name: 't',
    });
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

    // 心跳随回放（订阅前已发布）或实时投递到达
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('heartbeat not seen')), 3000);
      const poll = setInterval(() => {
        if (seen.includes(ClientAgentEventType.HEARTBEAT)) {
          clearTimeout(t);
          clearInterval(poll);
          resolve();
        }
      }, 10);
    });

    // 收尾（取消）：流以 END 结束——心跳发布已随 clearInterval 停止，channel 关闭后
    // 即使有迟到 publish 也是 no-op，订阅者不会再收到任何事件
    await h.service.deleteThread({ thread_id: THREAD_ID, user_id: USER_ID });
    await reading;

    expect(seen[seen.length - 1]).toBe(ClientAgentEventType.END);
    const heartbeatCount = seen.filter((t) => t === ClientAgentEventType.HEARTBEAT).length;
    expect(heartbeatCount).toBeGreaterThan(0);
  });
});
