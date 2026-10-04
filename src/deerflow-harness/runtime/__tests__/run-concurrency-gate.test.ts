import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * run 级并发闸门的排队 / 中止语义：名额满时 FIFO 等待；等待期间 signal 中止
 * 立即抛出并离队——被取消的 run 不占队位不占名额。
 */

const coord = vi.hoisted(() => ({ reserveResult: true }));

vi.mock('../../sandbox/docker/docker-coordinator', () => ({
  getSandboxCoordinator: () => ({
    tryReserveRun: async () => coord.reserveResult,
    releaseRun: async () => {},
  }),
}));

import { getRunConcurrencyGate } from '../run-concurrency-gate';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const savedMaxRuns = process.env.DEERFLOW_MAX_CONCURRENT_RUNS;

beforeEach(() => {
  process.env.DEERFLOW_MAX_CONCURRENT_RUNS = '1';
  coord.reserveResult = true;
});

afterEach(() => {
  if (savedMaxRuns === undefined) delete process.env.DEERFLOW_MAX_CONCURRENT_RUNS;
  else process.env.DEERFLOW_MAX_CONCURRENT_RUNS = savedMaxRuns;
});

describe('RunConcurrencyGate', () => {
  it('名额内立即放行；释放后名额归还（后续 acquire 可再次放行）', async () => {
    const gate = getRunConcurrencyGate();
    const release = await gate.acquire();
    release();
    const release2 = await gate.acquire();
    release2();
  });

  it('名额满 → FIFO 排队，前一个释放后放行', async () => {
    const gate = getRunConcurrencyGate();
    const release = await gate.acquire();

    let resolved = false;
    const pending = gate.acquire().then((r) => {
      resolved = true;
      return r;
    });
    await delay(30);
    expect(resolved).toBe(false);

    release();
    const r2 = await pending;
    r2();
  });

  it('排队期间 signal 中止 → 以中止原因抛出并离队，不影响后续等待者', async () => {
    const gate = getRunConcurrencyGate();
    const release = await gate.acquire();

    const controller = new AbortController();
    const pending = gate.acquire(undefined, controller.signal);
    await delay(10);
    controller.abort(new Error('cancelled: stopped by user'));

    await expect(pending).rejects.toThrow('cancelled: stopped by user');

    // 被中止者已离队：释放名额后新等待者正常放行（队列未被污染）
    release();
    const r3 = await gate.acquire();
    r3();
  });

  it('signal 已中止才调用 → 立即抛出，不进队列', async () => {
    const gate = getRunConcurrencyGate();
    const controller = new AbortController();
    controller.abort(new Error('cancelled: early'));

    await expect(gate.acquire(undefined, controller.signal)).rejects.toThrow('cancelled: early');
  });

  it('跨进程占位重试期间 signal 中止 → 立即抛出而非轮询到底', async () => {
    const gate = getRunConcurrencyGate();
    coord.reserveResult = false; // 占位永远失败：卡在重试循环里

    const controller = new AbortController();
    const pending = gate.acquire(undefined, controller.signal);
    await delay(20);
    controller.abort(new Error('cancelled: drain'));

    await expect(pending).rejects.toThrow('cancelled: drain');

    // 中止后名额归还：占位恢复放行后，后续 acquire 不再排队
    coord.reserveResult = true;
    const r = await gate.acquire();
    r();
  });
});
