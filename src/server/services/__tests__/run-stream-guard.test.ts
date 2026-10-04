import { describe, expect, it } from 'vitest';

import {
  ClientAgentEventType,
  createClientAgentEvent,
  type ClientAgentEvent,
  type SseStreamEvent,
  type StampedClientAgentEvent,
} from '@/deerflow-harness';
import { guardedStream } from '../run-stream-guard';

/**
 * 重连事件流守卫：锁「订阅不终止 / 提前终止」时按 runs 终态与 owner 存活
 * （心跳静默窗口）补发显式收尾的语义——重连请求必须明确报错而非无限挂起。
 * pollMs / ownerDeadAfterMs 注入极小值，测试不需要真实等待。
 */

const RUN_ID = 'run-1';

const chunk = (text: string): ClientAgentEvent =>
  createClientAgentEvent(ClientAgentEventType.STREAM_CHUNK, 'lead', { text });
const end = (): ClientAgentEvent => createClientAgentEvent(ClientAgentEventType.END, 'lead', {});

const isError = (ev: SseStreamEvent): boolean => ev.event.eventType === ClientAgentEventType.ERROR;

/** 可手动推进的订阅：push 投递事件、finish 结束迭代，模拟订阅端的各种行为。 */
function makeSubscription() {
  const queue: Array<IteratorResult<StampedClientAgentEvent>> = [];
  let resolveNext: ((r: IteratorResult<StampedClientAgentEvent>) => void) | null = null;
  let done = false;
  const it: AsyncIterator<StampedClientAgentEvent> = {
    async next(): Promise<IteratorResult<StampedClientAgentEvent>> {
      const q = queue.shift();
      if (q) return q;
      if (done) return { value: undefined, done: true };
      return new Promise((resolve) => {
        resolveNext = resolve;
      });
    },
    async return(): Promise<IteratorResult<StampedClientAgentEvent>> {
      done = true;
      resolveNext?.({ value: undefined, done: true });
      resolveNext = null;
      return { value: undefined, done: true };
    },
  };
  return {
    iterable: { [Symbol.asyncIterator]: () => it } as AsyncIterable<StampedClientAgentEvent>,
    push: (eventId: string, event: ClientAgentEvent) => {
      const r: IteratorResult<StampedClientAgentEvent> = {
        value: { eventId, event },
        done: false,
      };
      if (resolveNext) {
        const res = resolveNext;
        resolveNext = null;
        res(r);
      } else {
        queue.push(r);
      }
    },
    finish: () => {
      done = true;
      resolveNext?.({ value: undefined, done: true });
      resolveNext = null;
    },
  };
}

const makeRuns = (status: string) => {
  const row = { status };
  return { get: async () => row };
};

/** 读流直到结束（守卫保证以 END 收束），返回全部事件。 */
async function collectAll(gen: AsyncGenerator<SseStreamEvent>): Promise<SseStreamEvent[]> {
  const out: SseStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** 读流 ms 毫秒后中止（模拟客户端放弃），返回已收集事件——验证「不误判」场景。 */
async function collectWindow(
  gen: AsyncGenerator<SseStreamEvent>,
  ms: number,
): Promise<SseStreamEvent[]> {
  const out: SseStreamEvent[] = [];
  const timer = setTimeout(() => {
    void gen.return(undefined);
  }, ms);
  for await (const ev of gen) out.push(ev);
  clearTimeout(timer);
  return out;
}

describe('run-stream-guard', () => {
  it('事件透传（eventId 保留），END 终止且不补任何合成帧', async () => {
    const sub = makeSubscription();
    const gen = guardedStream(sub.iterable, makeRuns('succeeded'), RUN_ID);

    sub.push('10-1', chunk('a'));
    sub.push('10-2', end());
    const out = await collectAll(gen);

    expect(out.map((e) => e.eventId)).toEqual(['10-1', '10-2']);
    expect(out.map((e) => e.event.eventType)).toEqual([
      ClientAgentEventType.STREAM_CHUNK,
      ClientAgentEventType.END,
    ]);
  });

  it('订阅提前结束且 run 终态 → 补 RUN_STREAM_INCOMPLETE + END', async () => {
    const sub = makeSubscription();
    sub.finish(); // 订阅无 END 即结束（如内存实现的已释放通道）
    const gen = guardedStream(sub.iterable, makeRuns('failed'), RUN_ID);

    const out = await collectAll(gen);
    expect(out.filter(isError)).toHaveLength(1);
    expect((out[0].event.payload as { errorCode: string }).errorCode).toBe('RUN_STREAM_INCOMPLETE');
    expect(out[1].event.eventType).toBe(ClientAgentEventType.END);
  });

  it('订阅挂起且 run 终态 → 首个轮询周期即补 RUN_STREAM_INCOMPLETE + END', async () => {
    const sub = makeSubscription();
    const gen = guardedStream(sub.iterable, makeRuns('failed'), RUN_ID, { pollMs: 10 });

    const out = await collectAll(gen);
    expect((out[0].event.payload as { errorCode: string }).errorCode).toBe('RUN_STREAM_INCOMPLETE');
    expect(out).toHaveLength(2);
  });

  it('run 仍 running 且事件静默超过死亡阈值 → 补 RUN_OWNER_LOST + END', async () => {
    const sub = makeSubscription();
    const gen = guardedStream(sub.iterable, makeRuns('running'), RUN_ID, {
      pollMs: 10,
      ownerDeadAfterMs: 50,
    });

    const out = await collectAll(gen);
    expect(out).toHaveLength(2);
    expect((out[0].event.payload as { errorCode: string }).errorCode).toBe('RUN_OWNER_LOST');
    expect(out[1].event.eventType).toBe(ClientAgentEventType.END);
  });

  it('回放旧事件（游标内嵌旧时间戳）且 run running → 首个轮询周期即判 owner 死亡', async () => {
    const sub = makeSubscription();
    // 内嵌毫秒时间戳远早于当前时刻：静默年龄按事件真龄计，不等完整静默窗口
    sub.push('1000-1', chunk('old'));
    const gen = guardedStream(sub.iterable, makeRuns('running'), RUN_ID, {
      pollMs: 10,
      ownerDeadAfterMs: 50,
    });

    const out = await collectAll(gen);
    expect(out.map((e) => e.event.eventType)).toEqual([
      ClientAgentEventType.STREAM_CHUNK,
      ClientAgentEventType.ERROR,
      ClientAgentEventType.END,
    ]);
    expect((out[1].event.payload as { errorCode: string }).errorCode).toBe('RUN_OWNER_LOST');
  });

  it('订阅 return() 永不 settle → 守卫仍以 OWNER_LOST 收束（收尾不依赖订阅释放）', async () => {
    // 挂在内部 await 上的订阅实现：return 请求要等 yield 边界才处理，可能永不
    // settle——守卫的收尾帧不能因此卡死
    const sub = {
      [Symbol.asyncIterator]: (): AsyncIterator<StampedClientAgentEvent> => ({
        next: () => new Promise(() => {}), // 永不产出、永不终止
        return: () => new Promise(() => {}), // 永不 settle
      }),
    };

    const gen = guardedStream(sub, makeRuns('running'), RUN_ID, {
      pollMs: 10,
      ownerDeadAfterMs: 50,
    });

    const out = await collectAll(gen);
    expect(out).toHaveLength(2);
    expect((out[0].event.payload as { errorCode: string }).errorCode).toBe('RUN_OWNER_LOST');
    expect(out[1].event.eventType).toBe(ClientAgentEventType.END);
  });

  it('run running 且事件（心跳）持续到达 → 观察窗口内不判死', async () => {
    const sub = makeSubscription();
    const gen = guardedStream(sub.iterable, makeRuns('running'), RUN_ID, {
      pollMs: 10,
      ownerDeadAfterMs: 50,
    });

    // 心跳节奏 15ms < 死亡阈值 50ms，游标时间戳随到达时刻刷新：守卫必须持续
    // 等待。推送贯穿整个观察窗口（stop 标志收尾），避免「窗口计时器晚触发而
    // 推送已停」的假静默
    let stop = false;
    const pusher = (async () => {
      let i = 0;
      while (!stop) {
        sub.push(
          `${Date.now()}-${i}`,
          createClientAgentEvent(ClientAgentEventType.HEARTBEAT, 'lead', {}),
        );
        i += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    })();

    const out = await collectWindow(gen, 200);
    stop = true;
    await pusher;

    expect(out.length).toBeGreaterThanOrEqual(5);
    expect(out.every((e) => e.event.eventType === ClientAgentEventType.HEARTBEAT)).toBe(true);
  });
});
