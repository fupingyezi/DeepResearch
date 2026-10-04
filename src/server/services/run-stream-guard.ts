/**
 * 重连事件流守卫：把「订阅迭代」与「runs 终态 / owner 存活探测」合并成一条有序流。
 *
 * 订阅自身可能永远不终止（owner 崩溃的悬挂流、尚未产出首条事件的流），守卫在
 * 等待期插入定时探测，保证重连请求以显式收尾结束而非无限挂起：
 * - run 已到终态 → 补发 RUN_STREAM_INCOMPLETE ERROR + END
 * - run 仍 running 但事件流静默超过死亡阈值（3 个心跳窗口）→ owner 已死
 *   （kill -9 / 进程崩溃），补发 RUN_OWNER_LOST ERROR + END
 *
 * 静默判定用「事件游标内嵌的毫秒时间戳」（XADD 自增 id 的 ms 段）而非到达时刻：
 * 回放旧事件时立即反映真实年龄，重连后首个轮询周期即可判死，不必再等一整个
 * 静默窗口；无内嵌时间戳（进程内实现的十进制游标）时取到达时刻。
 */

import {
  ClientAgentEventType,
  HEARTBEAT_INTERVAL_MS,
  createClientAgentEvent,
  type SseStreamEvent,
  type StampedClientAgentEvent,
} from '@/deerflow-harness';

/** 终态 / 存活轮询间隔：订阅挂起期间定期探测，让悬挂流尽快收尾。 */
const TERMINAL_POLL_MS = 5_000;

/** owner 死亡判定阈值：3 个心跳窗口，容忍单次心跳抖动（与心跳间隔同源推导）。 */
const OWNER_DEAD_AFTER_MS = 3 * HEARTBEAT_INTERVAL_MS;

/** 事件游标内嵌时间戳形态：`{毫秒}-{序号}`。 */
const EMBEDDED_TS_RE = /^(\d+)-\d+$/;

/** runs 只读视图：守卫只问终态，不依赖具体存储实现。 */
export interface RunStatusReader {
  get(runId: string): Promise<{ status: string } | null>;
}

export interface RunStreamGuardOptions {
  pollMs?: number;
  ownerDeadAfterMs?: number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const systemError = (errorCode: string, errorMessage: string): SseStreamEvent[] => [
  {
    event: createClientAgentEvent(ClientAgentEventType.ERROR, 'system', {
      errorCode,
      errorMessage,
      recoverable: false,
    }),
  },
  { event: createClientAgentEvent(ClientAgentEventType.END, 'system', {} as never) },
];

export async function* guardedStream(
  subscription: AsyncIterable<StampedClientAgentEvent>,
  runs: RunStatusReader,
  runId: string,
  options: RunStreamGuardOptions = {},
): AsyncGenerator<SseStreamEvent> {
  const { pollMs = TERMINAL_POLL_MS, ownerDeadAfterMs = OWNER_DEAD_AFTER_MS } = options;

  let sawEnd = false;
  let ownerDead = false;
  let lastEventAt = Date.now();
  const it = subscription[Symbol.asyncIterator]();
  // 同一时刻至多挂起一个 next()：终态探测只是插入等待期，不与迭代器并发拉取
  let pending = it.next();
  try {
    for (;;) {
      const outcome = await Promise.race([pending, delay(pollMs).then(() => 'timeout' as const)]);
      if (outcome === 'timeout') {
        const run = await runs.get(runId);
        if (run && run.status !== 'running') break; // run 已终态：补尾帧收束
        if (run && Date.now() - lastEventAt > ownerDeadAfterMs) {
          // 仍 running 却连心跳都停摆：owner 进程已死，再等下去只会无限挂起
          ownerDead = true;
          break;
        }
        continue;
      }
      if (outcome.done) break;
      yield { eventId: outcome.value.eventId, event: outcome.value.event };
      const m = EMBEDDED_TS_RE.exec(outcome.value.eventId);
      lastEventAt = m ? Number(m[1]) : Date.now();
      if (outcome.value.event.eventType === ClientAgentEventType.END) {
        sawEnd = true;
        break;
      }
      pending = it.next();
    }
  } finally {
    // 收束后释放订阅：跨进程订阅挂起在 XREAD BLOCK 上，不显式 return 会泄漏连接
    pending.catch(() => undefined);
    await it.return?.().catch(() => undefined);
  }

  if (!sawEnd) {
    // 未收到 END：run 终态 / 流已过期 / owner 死亡。runs 是共享真相源，先按其
    // 终态收束；仍 running 时按 owner 死亡收束（两者互补，避免悬挂请求）
    const run = await runs.get(runId);
    if (run && run.status !== 'running') {
      yield* systemError(
        'RUN_STREAM_INCOMPLETE',
        '事件流中断且 run 已结束：后续内容请刷新对话查看落库结果。',
      );
    } else if (ownerDead) {
      yield* systemError(
        'RUN_OWNER_LOST',
        '运行进程已失去心跳（可能已崩溃）：本次结果不完整，请刷新对话查看。',
      );
    }
  }
}
