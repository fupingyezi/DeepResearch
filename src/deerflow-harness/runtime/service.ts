/**
 * ThreadService —— Thread 系统对外门面
 *
 * 装配：DeerFlowClient + Checkpointer + ThreadMetaStore + RunStore + StreamBridge + ALS Context
 *
 * 关键不变量：
 * - submitRun 立即返回 run_id，执行体 fire-and-forget
 * - 执行体 try/finally 兜底 publish END，并收敛 status（succeeded/failed → idle/error）
 * - 事件载荷直接复用 ClientAgentEvent，subscribe 返回 AsyncIterable<ClientAgentEvent>
 */

import { v4 as uuidv4 } from 'uuid';
import type { BaseCheckpointSaver } from '@langchain/langgraph';

import { DeerFlowClient } from '../client';
import {
  ClientAgentEventType,
  createClientAgentEvent,
  type ClientAgentEvent,
} from './sse/client-event';

import type { ThreadMeta, ThreadMetaStore, ThreadStatus } from '../persistence/thread-meta';
import type { RunStore } from '../persistence/runs';

import { buildThreadConfig } from './checkpointer';
import { runWithContext, type RuntimeContext } from './context';
import { streamBridge } from './stream-bridge';

const LOG = '[thread-service]';

export interface CreateThreadInput {
  /** 可选：外部指定 thread_id（用于和外部会话 ID 对齐，幂等创建）。不传则自动生成。 */
  thread_id?: string;
  user_id?: string;
  assistant_id?: string;
  display_name?: string;
  metadata?: Record<string, any>;
}

export interface ListThreadsOptions {
  user_id?: string;
  status?: ThreadStatus;
  limit?: number;
  offset?: number;
  metadata?: Record<string, any>;
}

export interface GetThreadInput {
  thread_id: string;
  user_id?: string;
  includeCheckpoint?: boolean;
}

export interface DeleteThreadInput {
  thread_id: string;
  user_id?: string;
}

export interface SubmitRunInput {
  thread_id: string;
  user_id?: string;
  input: string;
  metadata?: Record<string, any>;
}

export interface SubscribeInput {
  thread_id: string;
  run_id: string;
}

export interface GetCheckpointInput {
  thread_id: string;
  checkpoint_id?: string;
}

export interface ThreadService {
  createThread(input: CreateThreadInput): Promise<{ thread_id: string }>;
  listThreads(opts: ListThreadsOptions): Promise<ThreadMeta[]>;
  getThread(input: GetThreadInput): Promise<{ meta: ThreadMeta; checkpoint?: any } | null>;
  deleteThread(input: DeleteThreadInput): Promise<void>;
  submitRun(input: SubmitRunInput): Promise<{ run_id: string }>;
  subscribe(input: SubscribeInput): AsyncIterable<ClientAgentEvent>;
  getCheckpoint(input: GetCheckpointInput): Promise<any>;
  /** 占位：interrupt/resume 后续版本提供 */
  resume(input: { thread_id: string; run_id: string; decision: any }): Promise<never>;
}

export interface ThreadServiceDeps {
  client: DeerFlowClient;
  checkpointer: BaseCheckpointSaver;
  threads: ThreadMetaStore;
  runs: RunStore;
}

/** 自定义错误：携带 code 字段，用于路由层做精细化响应。 */
class ThreadServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ThreadServiceError';
  }
}

interface CheckpointerWithDeleteThread {
  deleteThread?: (threadId: string) => Promise<void>;
}

export function createThreadService(deps: ThreadServiceDeps): ThreadService {
  const { client, checkpointer, threads, runs } = deps;

  return {
    async createThread(input) {
      const thread_id = input.thread_id ?? uuidv4();
      // 外部指定 thread_id 时支持幂等：已存在则直接返回，不重复 create
      if (input.thread_id) {
        const existing = await threads.get(thread_id, { user_id: input.user_id ?? null });
        if (existing) {
          console.info(`${LOG} createThread idempotent thread_id=${thread_id}`);
          return { thread_id };
        }
      }
      await threads.create({
        thread_id,
        assistant_id: input.assistant_id ?? 'lead',
        user_id: input.user_id ?? null,
        display_name: input.display_name ?? 'New thread',
        metadata: input.metadata ?? {},
      });
      console.info(`${LOG} createThread thread_id=${thread_id}`);
      return { thread_id };
    },

    async listThreads(opts) {
      return threads.search({
        user_id: opts.user_id ?? null,
        status: opts.status,
        metadata: opts.metadata,
        limit: opts.limit,
        offset: opts.offset,
      });
    },

    async getThread({ thread_id, user_id, includeCheckpoint }) {
      const threadMeta = await threads.get(thread_id, { user_id: user_id ?? null });
      if (!threadMeta) return null;
      if (!includeCheckpoint) return { meta: threadMeta };
      const checkpoint = await getTupleSafe(checkpointer, thread_id);
      return { meta: threadMeta, checkpoint };
    },

    async deleteThread({ thread_id, user_id }) {
      await threads.delete(thread_id, { user_id: user_id ?? null });
      // PostgresSaver 1.x 提供 deleteThread；其它实现没有则跳过。
      const saver = checkpointer as BaseCheckpointSaver & CheckpointerWithDeleteThread;
      if (typeof saver.deleteThread === 'function') {
        try {
          await saver.deleteThread.call(saver, thread_id);
        } catch (e) {
          console.warn(`${LOG} deleteThread checkpoint cleanup failed:`, (e as Error)?.message);
        }
      }
      console.info(`${LOG} deleteThread thread_id=${thread_id}`);
    },

    async submitRun({ thread_id, user_id, input, metadata }) {
      const threadMeta = await threads.get(thread_id, { user_id: user_id ?? null });
      if (!threadMeta) {
        throw new ThreadServiceError(`thread not found: ${thread_id}`, 'NOT_FOUND');
      }

      const run_id = uuidv4();
      await runs.create({
        run_id,
        thread_id,
        assistant_id: threadMeta.assistant_id,
        user_id: user_id ?? null,
        input,
      });
      await threads.updateStatus(thread_id, 'running', { user_id: user_id ?? null });
      await runs.setStatus(run_id, 'running');

      const channel = streamBridge.channel(thread_id, run_id);
      const ctx: RuntimeContext = {
        thread_id,
        run_id,
        assistant_id: threadMeta.assistant_id,
        ...(user_id ? { user_id } : {}),
      };

      // fire-and-forget：不阻塞返回
      void (async () => {
        try {
          await runWithContext(ctx, async () => {
            const stream = client.stream(input, thread_id, metadata ?? {});
            for await (const ev of stream) {
              channel.publish(ev);
            }
          });

          await runs.setStatus(run_id, 'succeeded');
          await threads.updateStatus(thread_id, 'idle', { user_id: user_id ?? null });
          console.info(`${LOG} run succeeded thread_id=${thread_id} run_id=${run_id}`);
        } catch (e) {
          const message = (e as Error)?.message ?? String(e);
          channel.publish(
            createClientAgentEvent(ClientAgentEventType.ERROR, threadMeta.assistant_id, {
              errorCode: 'THREAD_RUN_ERROR',
              errorMessage: message,
              recoverable: false,
            }),
          );
          try {
            await runs.setStatus(run_id, 'failed', message);
            await threads.updateStatus(thread_id, 'error', { user_id: user_id ?? null });
          } catch (e2) {
            console.error(`${LOG} status persist on error failed:`, (e2 as Error)?.message);
          }
          console.error(`${LOG} run failed thread_id=${thread_id} run_id=${run_id} err=${message}`);
        } finally {
          // 兜底 END：channel 自身会去重（已 closed 后 publish 是 no-op）
          channel.publish(
            createClientAgentEvent(ClientAgentEventType.END, threadMeta.assistant_id, {} as never),
          );
        }
      })();

      return { run_id };
    },

    subscribe({ thread_id, run_id }) {
      return streamBridge.channel(thread_id, run_id).subscribe();
    },

    async getCheckpoint({ thread_id, checkpoint_id }) {
      return getTupleSafe(checkpointer, thread_id, checkpoint_id);
    },

    async resume() {
      throw new Error('[thread-service] resume is not implemented yet');
    },
  };
}

async function getTupleSafe(
  checkpointer: BaseCheckpointSaver,
  thread_id: string,
  checkpoint_id?: string,
): Promise<any> {
  const config = buildThreadConfig(thread_id, checkpoint_id);
  const fn = checkpointer.getTuple;
  if (typeof fn !== 'function') return null;
  try {
    return await fn.call(checkpointer, config);
  } catch (e) {
    console.warn(`${LOG} getTuple failed:`, (e as Error)?.message);
    return null;
  }
}
