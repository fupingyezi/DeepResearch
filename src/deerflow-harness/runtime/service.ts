/**
 * ThreadService —— Thread 系统对外门面
 *
 * 装配：DeerFlowClient + Checkpointer + ThreadMetaStore + RunStore + StreamBridge + ALS Context
 *
 * 关键不变量：
 * - submitRun 立即返回 run_id，执行体 fire-and-forget
 * - 执行体 try/finally 兜底 publish END，并收敛 status（succeeded/failed → idle/error）
 * - 事件载荷复用 ClientAgentEvent，subscribe 返回带续读游标的 AsyncIterable<StampedClientAgentEvent>
 */

import { v4 as uuidv4 } from 'uuid';
import type { BaseCheckpointSaver } from '@langchain/langgraph';

import { DeerFlowClient } from '../client';
import {
  ClientAgentEventType,
  createClientAgentEvent,
  type ClientAgentEvent,
  type StampedClientAgentEvent,
} from './sse/client-event';
import { consumeTitleUpdate } from '../agents/middlewares/title-middleware/title-bus';

import type { ThreadMeta, ThreadMetaStore, ThreadStatus } from '../persistence/thread-meta';
import type { RunStore } from '../persistence/runs';
import type { ModelConfig } from '../types';
import type { ThreadImageRef } from '../vision';

import { buildThreadConfig } from './checkpointer';
import { runWithContext, type RuntimeContext } from './context';
import { getRunConcurrencyGate } from './run-concurrency-gate';
import { getSandboxProvider } from '../sandbox';
import { getDistLock, type DistLockHandle } from './locks/dist-lock';
import type { RunRegistry, RunEventBus } from './contracts';
import { InMemoryRunRegistry } from './run-registry/in-memory';
import { InMemoryRunEventBus } from './event-bus/in-memory';
import { getInstanceOwner } from './instance-id';
import { HEARTBEAT_INTERVAL_MS } from './liveness';
import { reconcileZombieRuns } from './zombie-reconciler';

const LOG = '[thread-service]';

/** 优雅停机等待在跑 run 收尾的缺省上限（DEERFLOW_GRACEFUL_DRAIN_MS 可覆盖）。 */
const GRACEFUL_DRAIN_MS = (() => {
  const raw = Number(process.env.DEERFLOW_GRACEFUL_DRAIN_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30_000;
})();

/** 取消 run 后等待其收尾的上限：超时就继续删，不能让一个卡住的 run 拖死删除请求。 */
const RUN_CANCEL_GRACE_MS = 3_000;

/** thread 锁 TTL：覆盖临界区上限（取消收尾 3s + 登记），只兜底持有者崩溃，不续期。 */
const THREAD_LOCK_TTL_MS = 10_000;
/** thread 锁等待预算：须大于另一持有者完整走完临界区的时间，超时继续执行并告警。 */
const THREAD_LOCK_WAIT_MS = 6_000;

/** 被取消的 run 在 runs.error 里的标记（RunStatus 是 DB CHECK 约束的枚举，没有 cancelled）。 */
const RUN_CANCELLED_ERROR = 'cancelled: thread deleted';
/** 用户点「停止」：前端 abort 只断 SSE，服务端 run 必须显式取消，否则会继续烧 token 并落库完整回答。 */
const RUN_CANCELLED_BY_USER = 'cancelled: stopped by user';
/** 同一 thread 只允许一个 run：新 run 抢占上一个未结束的（两个 run 并发写同一份 checkpoint 会交错）。 */
const RUN_CANCELLED_SUPERSEDED = 'cancelled: superseded by a new run';
/** 优雅停机等待窗口耗尽后取消仍未收尾的 run。 */
const RUN_CANCELLED_DRAINING = 'cancelled: server draining';

/**
 * run 终态后延迟释放事件通道的宽限：覆盖「刷新页面 / 网络抖动后重连订阅」的
 * 时间跨度。宽限内晚订阅仍可回放；宽限后内存实现丢 buffer（channel 泄漏修复），
 * Redis 实现由 stream 的 24h TTL 兜底续读。
 */
const EVENT_RELEASE_GRACE_MS = 5 * 60_000;

/** 心跳间隔与死亡阈值的唯一定义（重连守卫 / owner 登记续租共用，见 liveness.ts）。 */
export { HEARTBEAT_INTERVAL_MS } from './liveness';

/**
 * 等 registry 里该 thread 的在跑 run 清空，最多 ms 毫秒。
 *
 * 只能轮询注册表：owner 进程的收尾 Promise 在其它进程里拿不到，而「等清空」是
 * 抢占/销毁两条路径的共同前置（同一 thread 的 checkpoint 不允许两个 run 并发写）。
 * 取消收尾是微任务级，25ms 轮询一次足以在首个间隔内命中，超时照常继续。
 */
async function waitForRunsDrained(
  registry: RunRegistry,
  thread_id: string,
  ms: number,
): Promise<void> {
  const POLL_INTERVAL_MS = 25;
  const deadline = Date.now() + ms;
  for (;;) {
    const running = await registry.listByThread(thread_id);
    if (running.length === 0) return;
    if (Date.now() >= deadline) return;
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

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

export interface CancelRunInput {
  thread_id: string;
  user_id?: string;
}

export interface SubmitRunInput {
  thread_id: string;
  user_id?: string;
  input: string;
  /**
   * 本轮随消息附带的线程图片（v3/chat 由 file_content 解析出 minioKey 等）。
   * 走显式参数而非 metadata —— metadata 会被 `...metadata` 展开进每个事件
   * 载荷，塞图片引用会污染前端协议。空数组/缺省 = 无图（纯文本，现状行为）。
   */
  images?: ThreadImageRef[];
  metadata?: Record<string, any>;
  /**
   * 本次 run 使用的模型配置。带模型配置时由 createClientForModel 解析出对应
   * DeerFlowClient；不传则使用装配时的默认 client。
   * 注意：modelConfig 不会进入 client.stream 的 metadata（避免污染事件载荷）。
   */
  modelConfig?: ModelConfig;
}

export interface SubscribeInput {
  thread_id: string;
  run_id: string;
  /** 断点续读游标（客户端重连带回最后收到的 eventId）；缺省全量回放。 */
  fromEventId?: string;
}

export interface ResumeRunInput {
  thread_id: string;
  user_id?: string;
  /** 用户对 interrupt（如 ask_clarification）的决策，作为 Command(resume) 的载荷。 */
  decision: unknown;
  metadata?: Record<string, any>;
  /** 与 submitRun 一致：带模型配置时解析对应 client。 */
  modelConfig?: ModelConfig;
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
  /**
   * 取消该 thread 在跑的 run（用户点「停止」）。返回取消请求投递数——单进程
   * 实现即命中数，跨进程实现为「已送达 owner」的投递数（拿不到远端命中回报）；
   * thread 不存在抛 NOT_FOUND。
   */
  cancelRun(input: CancelRunInput): Promise<{ cancelled: number }>;
  submitRun(input: SubmitRunInput): Promise<{ run_id: string }>;
  subscribe(input: SubscribeInput): AsyncIterable<StampedClientAgentEvent>;
  getCheckpoint(input: GetCheckpointInput): Promise<any>;
  /**
   * 续跑被 interrupt 暂停的 thread：以用户决策 decision 作为 Command(resume) 输入，
   * 复用同一 thread_id（共享 checkpoint），返回新的 run_id。事件经 StreamBridge 推送。
   */
  resume(input: ResumeRunInput): Promise<{ run_id: string }>;
  /**
   * 优雅停机：置 draining 后不再接受新 run（submitRun / resume 抛 SERVER_DRAINING），
   * 等待本进程在跑的 run 自然收尾，超时后取消它们并再等一轮收尾（执行体 finally
   * 保证 END 落流）。幂等：重复调用返回同一 Promise。返回 cancelled = 超时后取消
   * 的 run 数，pending = 取消后仍未收尾的残留数（正常为 0）。
   */
  beginShutdown(drainMs?: number): Promise<{ cancelled: number; pending: number }>;
  /** 健康视图：distributed = 跨进程登记表与事件总线均可用；draining = 停机流程已启动。 */
  health(): Promise<{ distributed: boolean; draining: boolean }>;
  /** 启动对账：把「running 但 owner 已死」的 run 修正为 failed（语义见 zombie-reconciler）。 */
  reconcileZombieRuns(): Promise<{ reaped: number }>;
}

export interface ThreadServiceDeps {
  client: DeerFlowClient;
  checkpointer: BaseCheckpointSaver;
  threads: ThreadMetaStore;
  runs: RunStore;
  /**
   * 可选：按模型配置解析 DeerFlowClient。用于单次请求切换模型——
   * submitRun 携带 modelConfig 时调用此工厂获取对应 client（实现侧自行缓存）。
   * 缺省时一律使用默认 client。
   */
  createClientForModel?: (modelConfig: ModelConfig) => DeerFlowClient;
  /**
   * 可选：进程间契约实现（RunRegistry / RunEventBus）。缺省为进程内实现；
   * 跨进程部署在装配侧注入对应实现。
   */
  registry?: RunRegistry;
  eventBus?: RunEventBus;
  /** 可选：存活心跳间隔。缺省 HEARTBEAT_INTERVAL_MS；测试注入更短间隔观察心跳。 */
  heartbeatIntervalMs?: number;
}

/** 自定义错误：携带 code 字段，用于路由层做精细化响应。 */
export class ThreadServiceError extends Error {
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

async function getTupleSafe(
  checkpointer: BaseCheckpointSaver,
  thread_id: string,
  checkpoint_id?: string,
): Promise<unknown> {
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

export function createThreadService(deps: ThreadServiceDeps): ThreadService {
  const { client, checkpointer, threads, runs, createClientForModel } = deps;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const runRegistry: RunRegistry = deps.registry ?? new InMemoryRunRegistry();
  const runEventBus: RunEventBus = deps.eventBus ?? new InMemoryRunEventBus();

  // 进程内「在跑的 run」控制句柄表：run_id → { thread_id, controller }。
  //
  // 用途：删除对话时先取消它正在跑的 run。run 是 fire-and-forget，不取消的话它会在
  // threads_meta / checkpoint 被清掉之后继续为自己的 thread 写 checkpoint，把刚清理
  // 干净的数据又写回来。
  //
  // controller 不可序列化，只能留在 owner 进程的闭包里；取消请求经 runRegistry 以
  // 消息式送达本进程（下方 handler），handler 命中这里才真正 abort。句柄表与
  // registry 的登记严格同步：executeRun 里同点 set / register，finally 里同点注销。
  // 必须按 run_id 挂在 createThreadService 的闭包里：service 与 client 都是进程级共享
  // 实例，多 run 并行时不能把控制句柄做成单例字段。
  const activeRuns = new Map<string, { thread_id: string; controller: AbortController }>();

  // 消息式取消的唯一落点：收到本进程名下 run 的取消请求时 abort 对应 controller。
  // 返回 1 = 命中（本进程是 owner 且 run 还在跑），0 = run 不在本进程（已收尾）。
  runRegistry.onCancelRequest((runId, reason) => {
    const entry = activeRuns.get(runId);
    if (!entry) return 0;
    entry.controller.abort(new Error(reason));
    return 1;
  });

  /**
   * 取消某 thread 名下所有在跑的 run。
   *
   * wait=true 用于「抢占 / 销毁」这两类必须确保对方停笔的场景（同一 thread 的 checkpoint
   * 不允许两个 run 并发写）；用户点「停止」用 wait=false，立刻返回不拖慢交互。
   * 取消请求经 runRegistry 投递（跨进程时到达 owner 进程），投递数即取消数。
   */
  const cancelThreadRuns = async (
    thread_id: string,
    reason: string,
    wait: boolean,
  ): Promise<number> => {
    const running = await runRegistry.listByThread(thread_id);
    if (running.length === 0) return 0;
    let cancelled = 0;
    for (const info of running) {
      cancelled += await runRegistry.requestCancel(info.runId, reason);
    }
    if (wait) {
      await waitForRunsDrained(runRegistry, thread_id, RUN_CANCEL_GRACE_MS);
    }
    return cancelled;
  };

  /**
   * thread 级互斥临界区：包住「取消在跑的 run → 等清空 → 建新 run / 删数据」。
   *
   * 锁要保护的是「查在跑集合」到「新 run 登记」之间不被另一个进程插入同样的
   * 序列：两个进程都看到空集合、都开始写同一份 checkpoint，抢占语义就失效了。
   * 用户点「停止」只广播取消、不写 checkpoint，不需要锁。
   * 等待期轮询获取（50ms）；超预算说明对方异常，继续执行并告警——锁是防错
   * 而非门禁，不应把正常请求挡在等锁上。
   */
  const withThreadLock = async <T>(thread_id: string, fn: () => Promise<T>): Promise<T> => {
    const lock = getDistLock();
    const lockKey = `deerflow:lock:thread:${thread_id}`;
    const deadline = Date.now() + THREAD_LOCK_WAIT_MS;
    let handle: DistLockHandle | null = null;
    for (;;) {
      handle = await lock.acquire(lockKey, THREAD_LOCK_TTL_MS);
      if (handle) break;
      if (Date.now() >= deadline) {
        console.warn(
          `${LOG} thread lock wait timeout thread_id=${thread_id}; proceed without lock`,
        );
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    try {
      return await fn();
    } finally {
      await handle?.release();
    }
  };

  // 优雅停机状态。draining 置位后 submitRun / resume 在入口即拒绝（SERVER_DRAINING），
  // 已提交的执行体照常跑到收尾；beginShutdown 幂等，重复调用复用同一 Promise。
  let draining = false;
  let shutdownPromise: Promise<{ cancelled: number; pending: number }> | null = null;

  const beginShutdown = (
    drainMs = GRACEFUL_DRAIN_MS,
  ): Promise<{ cancelled: number; pending: number }> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      draining = true;
      // activeRuns 是「本进程在跑的 run」的收尾完成标志：执行体 finally 在
      // 状态落库 + END 落流之后才摘除条目，轮询到空即全部善后完成
      const waitEmpty = async (ms: number): Promise<void> => {
        const deadline = Date.now() + ms;
        while (activeRuns.size > 0) {
          if (Date.now() >= deadline) return;
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
      };
      await waitEmpty(drainMs);
      let cancelled = 0;
      if (activeRuns.size > 0) {
        for (const [, entry] of activeRuns) {
          entry.controller.abort(new Error(RUN_CANCELLED_DRAINING));
          cancelled += 1;
        }
        // 取消后执行体还要走完收尾（状态落库 + END 落流），再给一轮宽限；
        // 残留由进程退出兜底，不无限等待
        await waitEmpty(RUN_CANCEL_GRACE_MS);
      }
      console.info(`${LOG} drain done cancelled=${cancelled} pending=${activeRuns.size}`);
      return { cancelled, pending: activeRuns.size };
    })();
    return shutdownPromise;
  };

  // 统一的 run 执行器：submitRun（首轮）与 resume（续跑）共用。
  // 关键不变量：fire-and-forget 立即返回 run_id；try/catch/finally 三段收敛状态，
  // finally 始终 publish END（channel 对已 closed 的 publish 是 no-op）。
  const executeRun = async (params: {
    thread_id: string;
    user_id?: string;
    threadMeta: ThreadMeta;
    inputForDb: string;
    makeStream: (signal: AbortSignal) => AsyncIterable<ClientAgentEvent>;
  }): Promise<{ run_id: string }> => {
    const { thread_id, user_id, threadMeta, inputForDb, makeStream } = params;

    const run_id = uuidv4();
    await runs.create({
      run_id,
      thread_id,
      assistant_id: threadMeta.assistant_id,
      user_id: user_id ?? null,
      input: inputForDb,
    });
    await threads.updateStatus(thread_id, 'running', { user_id: user_id ?? null });
    await runs.setStatus(run_id, 'running');

    const ctx: RuntimeContext = {
      thread_id,
      run_id,
      assistant_id: threadMeta.assistant_id,
      ...(user_id ? { user_id } : {}),
    };

    const controller = new AbortController();
    activeRuns.set(run_id, { thread_id, controller });
    await runRegistry.register({
      runId: run_id,
      threadId: thread_id,
      owner: getInstanceOwner(),
      startedAt: Date.now(),
    });

    void (async () => {
      let releaseRunSlot: (() => void) | null = null;

      // 存活心跳贯穿整个执行体（含排队窗口）：unref 不阻止进程退出；finally 里
      // 与 END 发布前停止，晚到的心跳不会复活已释放的事件流
      const heartbeat = setInterval(() => {
        void runEventBus.publish(
          thread_id,
          run_id,
          createClientAgentEvent(ClientAgentEventType.HEARTBEAT, threadMeta.assistant_id, {}),
        );
        // 同步续租 owner 登记键：键存活 = owner 存活，跨进程僵尸回收凭 ownerOf
        // 判死。心跳停摆（进程崩溃 / kill -9）后键在死亡窗口内到期
        void runRegistry.touch(run_id);
      }, heartbeatIntervalMs);
      heartbeat.unref?.();

      // 取消收尾：RunStatus 是 DB CHECK 约束的枚举（无 cancelled 值），复用 failed +
      // error 文案，不为一个语义加一次迁移；thread 状态回 idle —— 对话已被删时是 0 行
      // no-op，将来若开「停止按钮」这条路也是对的。
      // 取消原因取自 abort(reason)：删除对话 / 用户停止 / 被新 run 抢占，三者文案不同，
      // 都统一以 'cancelled:' 开头，便于按 runs.error 检索。
      const cancelReasonText = (): string =>
        controller.signal.reason instanceof Error
          ? controller.signal.reason.message
          : String(controller.signal.reason ?? RUN_CANCELLED_ERROR);

      const settleCancelled = async (): Promise<void> => {
        const reason = cancelReasonText();
        try {
          await runs.setStatus(run_id, 'failed', reason);
          await threads.updateStatus(thread_id, 'idle', { user_id: user_id ?? null });
        } catch (e) {
          console.error(`${LOG} status persist on cancel failed:`, (e as Error)?.message);
        }
        console.info(
          `${LOG} run cancelled thread_id=${thread_id} run_id=${run_id} reason=${reason}`,
        );
      };

      try {
        // run 级并发闸门：超限时先回传「排队中」状态帧（复用 task_progress 语义，
        // 仅增字段不破坏白名单），对话可先思考，执行体延迟到放行后启动。
        // 传入 controller.signal：排队期间被取消（停止 / 抢占 / 停机）直接抛出，
        // 不必等放行——被取消的 run 不应占着队列名额
        releaseRunSlot = await getRunConcurrencyGate().acquire(() => {
          // 闸门回调是同步的，publish 用 void 触发：进程内实现的发布体同步执行，
          // 「排队中」帧保证落在后续任何事件之前。
          void runEventBus.publish(
            thread_id,
            run_id,
            createClientAgentEvent(ClientAgentEventType.TASK_PROGRESS, threadMeta.assistant_id, {
              taskId: run_id,
              status: 'queued',
              description: 'Run queued: concurrency limit reached, waiting for a free slot.',
            }),
          );
        }, controller.signal);

        // 排队期间就被取消（对话在等锁时被删）：不必再启动
        if (controller.signal.aborted) {
          await settleCancelled();
          return;
        }

        await runWithContext(ctx, async () => {
          for await (const ev of makeStream(controller.signal)) {
            await runEventBus.publish(thread_id, run_id, ev);
          }
        });

        // client.stream() 会把异常吞成 ERROR 事件后正常 return（见其 catch），所以
        // 「被取消」不会走下面的 catch —— 只能在这里显式看 signal，否则一次取消会被
        // 记成 succeeded。
        if (controller.signal.aborted) {
          await settleCancelled();
          return;
        }

        await runs.setStatus(run_id, 'succeeded');
        await threads.updateStatus(thread_id, 'idle', { user_id: user_id ?? null });
        console.info(`${LOG} run succeeded thread_id=${thread_id} run_id=${run_id}`);
      } catch (e) {
        // 取消可能以异常形式冒出来（且被 LangChain 中间件链包上前缀），此时按取消处理：
        // 统一用取消原因落库、不再发 ERROR 帧（否则前端会看到一条无意义的「运行出错」）。
        const cancelled = controller.signal.aborted;
        const message = cancelled ? cancelReasonText() : ((e as Error)?.message ?? String(e));
        if (!cancelled) {
          await runEventBus.publish(
            thread_id,
            run_id,
            createClientAgentEvent(ClientAgentEventType.ERROR, threadMeta.assistant_id, {
              errorCode: 'THREAD_RUN_ERROR',
              errorMessage: message,
              recoverable: false,
            }),
          );
        }
        try {
          await runs.setStatus(run_id, 'failed', message);
          await threads.updateStatus(thread_id, cancelled ? 'idle' : 'error', {
            user_id: user_id ?? null,
          });
        } catch (e2) {
          console.error(`${LOG} status persist on error failed:`, (e2 as Error)?.message);
        }
        console.error(
          `${LOG} run ${cancelled ? 'cancelled' : 'failed'} thread_id=${thread_id} run_id=${run_id} err=${message}`,
        );
      } finally {
        clearInterval(heartbeat);
        if (releaseRunSlot) releaseRunSlot();
        activeRuns.delete(run_id);
        await runRegistry.unregister(run_id);
        // autoTitle 结果折进 END 载荷：跨进程部署下消费端可能不在 owner 进程，
        // 拿不到进程内 title-bus，标题更新必须随事件流本身走
        const titleUpdate = consumeTitleUpdate(thread_id);
        await runEventBus.publish(
          thread_id,
          run_id,
          createClientAgentEvent(
            ClientAgentEventType.END,
            threadMeta.assistant_id,
            titleUpdate ? { titleUpdate } : ({} as never),
          ),
        );
        // 延迟释放事件通道（宽限后）：内存实现丢弃 buffer 回收内存，Redis 实现
        // 依赖 stream TTL。unref 不阻止进程退出，测试环境不产生悬挂 timer。
        const releaseTimer = setTimeout(() => {
          void runEventBus.release(thread_id, run_id);
        }, EVENT_RELEASE_GRACE_MS);
        releaseTimer.unref?.();
      }
    })();

    return { run_id };
  };

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
      await withThreadLock(thread_id, async () => {
        // 先取消这个 thread 还在跑的 run，并等它收尾（最多 RUN_CANCEL_GRACE_MS）：
        // 否则 run 会在 meta / checkpoint 清完之后继续写 checkpoint，把刚删掉的数据写回来。
        const cancelled = await cancelThreadRuns(thread_id, RUN_CANCELLED_ERROR, true);
        if (cancelled > 0) {
          console.info(
            `${LOG} deleteThread cancelled ${cancelled} running run(s) thread_id=${thread_id}`,
          );
        }

        await threads.delete(thread_id, { user_id: user_id ?? null });
        // 销毁对话时联动销毁其沙箱容器（Local 后端为 no-op）。
        try {
          getSandboxProvider().releaseByThreadId(thread_id);
        } catch (e) {
          console.warn(`${LOG} deleteThread sandbox release failed:`, (e as Error)?.message);
        }
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
      });
    },

    async cancelRun({ thread_id, user_id }) {
      // 归属校验：threads.get 按 user_id 过滤，别人的 / 不存在的 thread 都拿不到
      const threadMeta = await threads.get(thread_id, { user_id: user_id ?? null });
      if (!threadMeta) {
        throw new ThreadServiceError(`thread not found: ${thread_id}`, 'NOT_FOUND');
      }
      // 不等收尾：用户点「停止」要立刻有响应，run 自己会走取消收尾（状态落 failed）
      const cancelled = await cancelThreadRuns(thread_id, RUN_CANCELLED_BY_USER, false);
      console.info(`${LOG} cancelRun thread_id=${thread_id} cancelled=${cancelled}`);
      return { cancelled };
    },

    async submitRun({ thread_id, user_id, input, images, metadata, modelConfig }) {
      if (draining) {
        throw new ThreadServiceError('server is draining', 'SERVER_DRAINING');
      }
      const threadMeta = await threads.get(thread_id, { user_id: user_id ?? null });
      if (!threadMeta) {
        throw new ThreadServiceError(`thread not found: ${thread_id}`, 'NOT_FOUND');
      }

      // 抢占 + 登记在 thread 锁内完成：锁住的不是 run 全程，而是「取消旧的 → 登记新的」
      // 这段临界区。run 全程锁会与新 submit 的抢占死锁（新 submit 等锁、锁被旧 run 占着）。
      return withThreadLock(thread_id, async () => {
        // 同一 thread 只允许一个 run：上一个还没停就先取消并等它停笔，否则两个 run 会并发写
        // 同一份 LangGraph checkpoint（实测交错增长），对话状态会坏。
        const superseded = await cancelThreadRuns(thread_id, RUN_CANCELLED_SUPERSEDED, true);
        if (superseded > 0) {
          console.info(
            `${LOG} submitRun superseded ${superseded} running run(s) thread_id=${thread_id}`,
          );
        }

        // 单次请求模型切换：带 modelConfig 且注入了工厂时解析对应 client，
        // 否则用装配时的默认 client。统一走「submitRun → channel」单路径，
        // 不再有 route 层 dynamicClient 直连分支。
        const runClient =
          modelConfig && createClientForModel ? createClientForModel(modelConfig) : client;

        return executeRun({
          thread_id,
          user_id,
          threadMeta,
          inputForDb: input,
          makeStream: (signal) =>
            runClient.stream(
              input,
              thread_id,
              metadata ?? {},
              images?.length ? { images } : undefined,
              signal,
            ),
        });
      });
    },

    subscribe({ thread_id, run_id, fromEventId }) {
      return runEventBus.subscribe(thread_id, run_id, fromEventId);
    },

    async getCheckpoint({ thread_id, checkpoint_id }) {
      return getTupleSafe(checkpointer, thread_id, checkpoint_id);
    },

    async resume({ thread_id, user_id, decision, metadata, modelConfig }) {
      if (draining) {
        throw new ThreadServiceError('server is draining', 'SERVER_DRAINING');
      }
      const threadMeta = await threads.get(thread_id, { user_id: user_id ?? null });
      if (!threadMeta) {
        throw new ThreadServiceError(`thread not found: ${thread_id}`, 'NOT_FOUND');
      }

      // 与 submitRun 同一把 thread 锁：续跑同样要「停旧的 → 登记新的」原子成段。
      return withThreadLock(thread_id, async () => {
        // 同上：续跑也占用同一个 thread 的 checkpoint，先让在跑的 run 停笔
        const superseded = await cancelThreadRuns(thread_id, RUN_CANCELLED_SUPERSEDED, true);
        if (superseded > 0) {
          console.info(
            `${LOG} resume superseded ${superseded} running run(s) thread_id=${thread_id}`,
          );
        }

        const runClient =
          modelConfig && createClientForModel ? createClientForModel(modelConfig) : client;
        const decisionText =
          typeof decision === 'string' ? decision : JSON.stringify(decision ?? '');

        return executeRun({
          thread_id,
          user_id,
          threadMeta,
          inputForDb: decisionText,
          makeStream: (signal) =>
            runClient.resumeStream(decision, thread_id, metadata ?? {}, signal),
        });
      });
    },

    beginShutdown,
    health: async () => {
      // 先确保实现就绪再判模式：懒建连下「尚未连接」与「连接失败已降级」都表现为
      // connected=false，只有前者不该被报告为降级
      await runRegistry.ready();
      await runEventBus.ready();
      return {
        distributed: runRegistry.isDistributed() && runEventBus.isDistributed(),
        draining,
      };
    },
    reconcileZombieRuns: () => reconcileZombieRuns({ runs, threads, registry: runRegistry }),
  };
}
