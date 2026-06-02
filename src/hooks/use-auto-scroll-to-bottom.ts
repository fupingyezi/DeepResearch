'use client';

import { useCallback, useEffect, useRef, type RefObject } from 'react';

const PROGRAMMATIC_WINDOW_MS = 120;

export interface UseAutoScrollToBottomOptions {
  /** 滚动容器 ref */
  containerRef: RefObject<HTMLDivElement | null>;
  /**
   * 是否启用自动滚到底。
   * 语义：仅由"用户发送消息"这一外部动作置 true；hook 内部只会把它置 false，
   * 不会自动恢复 true。即用户一旦滑动就彻底脱钩，直到下一次发送消息。
   */
  enabled: boolean;
  /** 用户滑动后用于关闭自动滚动的回调 */
  setEnabled: (next: boolean) => void;
  /** 触发滚动检查的依赖（通常是 messages 引用，新消息或新 token 到达时滚到底） */
  trigger: unknown;
}

export interface UseAutoScrollToBottomReturn {
  /** 绑定到容器 onScroll：用户任意方式滚动均关闭跟随 */
  onScroll: () => void;
  /** 绑定到容器 onWheel：滚轮/触控板滑动也关闭跟随 */
  onWheel: () => void;
  /** 绑定到容器 onTouchMove：移动端触摸滑动也关闭跟随 */
  onTouchMove: () => void;
}

/**
 * useAutoScrollToBottom
 *
 * 行为约定：
 * 1) trigger 变化 + enabled === true → 自动 scrollTop = scrollHeight；
 * 2) 用户任何滑动（wheel / 触控板 / 触摸 / 拖滚动条 / 键盘）→ 立刻 setEnabled(false)，
 *    且**不会自动恢复**——必须等外部把 enabled 重新置 true（发送消息时）。
 */
export function useAutoScrollToBottom(
  opts: UseAutoScrollToBottomOptions,
): UseAutoScrollToBottomReturn {
  const { containerRef, enabled, setEnabled, trigger } = opts;
  const enabledRef = useRef(enabled);
  const programmaticScrollRef = useRef<boolean>(false);
  const programmaticScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    programmaticScrollRef.current = true;
    if (programmaticScrollTimerRef.current) {
      clearTimeout(programmaticScrollTimerRef.current);
    }

    container.scrollTop = container.scrollHeight;

    programmaticScrollTimerRef.current = setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticScrollTimerRef.current = null;
    }, PROGRAMMATIC_WINDOW_MS);
  }, [containerRef]);

  useEffect(() => {
    if (!containerRef.current) return;
    if (!enabledRef.current) return;
    scrollToBottom();
    // 仅以 trigger 变更驱动滚动；enabled 变更不应触发滚动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger]);

  useEffect(() => {
    return () => {
      if (programmaticScrollTimerRef.current) {
        clearTimeout(programmaticScrollTimerRef.current);
      }
    };
  }, []);

  /** 唯一的关闭路径：用户任何滑动都走这里。同步写 ref 防止下一帧 trigger effect 仍读旧值。 */
  const disableByUser = useCallback(() => {
    if (programmaticScrollRef.current) return;
    if (!enabledRef.current) return;
    enabledRef.current = false;
    setEnabled(false);
  }, [setEnabled]);

  return {
    onScroll: disableByUser,
    onWheel: disableByUser,
    onTouchMove: disableByUser,
  };
}

export default useAutoScrollToBottom;
