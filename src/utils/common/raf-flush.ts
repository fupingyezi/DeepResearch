/**
 * requestAnimationFrame 合帧调度器。
 *
 * 用于 class 内部的高频状态合帧（如 SSE 流式聚合 → React setState）。
 * Class 与 React Hook 不互通，故抽为纯工厂函数。
 *
 * SSR 兜底：`typeof window === 'undefined'` 时回退到 setTimeout(16ms)。
 */

export interface RafFlusher {
  /** 请求合帧调度（多次调用会合到同一帧 commit 一次） */
  schedule(): void;
  /** 取消挂起 + 立即同步执行 commit */
  flushSync(): void;
  /** 仅取消挂起，不执行 commit */
  cancel(): void;
}

export function createRafFlusher(commit: () => void): RafFlusher {
  let handle: number | null = null;
  let pending = false;

  const schedule =
    typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : (cb: FrameRequestCallback): number => {
          const id = setTimeout(() => cb(performance.now()), 16);
          return Number(id);
        };

  const cancelRaf =
    typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function'
      ? window.cancelAnimationFrame.bind(window)
      : (id: number): void => {
          // SSR / 非浏览器环境：handle 实际是 setTimeout id（数值兼容）
          clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
        };

  return {
    schedule(): void {
      pending = true;
      if (handle !== null) return;
      handle = schedule(() => {
        handle = null;
        if (!pending) return;
        pending = false;
        commit();
      });
    },
    flushSync(): void {
      if (handle !== null) {
        cancelRaf(handle);
        handle = null;
      }
      pending = false;
      commit();
    },
    cancel(): void {
      if (handle !== null) {
        cancelRaf(handle);
        handle = null;
      }
      pending = false;
    },
  };
}
