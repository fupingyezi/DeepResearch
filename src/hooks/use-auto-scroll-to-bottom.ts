'use client';

import { useCallback, useEffect, useRef, type RefObject } from 'react';

export interface UseAutoScrollToBottomOptions {
  /** 滚动容器 ref */
  containerRef: RefObject<HTMLDivElement | null>;
  /** 是否启用自动滚到底（false 时不会主动滚动） */
  enabled: boolean;
  /** 用户操作（wheel / 滚到底）后回写 enabled 的回调 */
  setEnabled: (next: boolean) => void;
  /** 触发滚动检查的依赖（通常是 messages 引用，新消息到达时滚到底） */
  trigger: unknown;
}

export interface UseAutoScrollToBottomReturn {
  /** 绑定到容器 onScroll 的回调（不依赖事件入参） */
  onScroll: () => void;
  /** 绑定到容器 onWheel 的回调（基于 wheel deltaY 判断滚动方向） */
  onWheel: (event: React.WheelEvent<HTMLDivElement>) => void;
}

/**
 * useAutoScrollToBottom
 *
 * 1) trigger 变化（新消息/编辑）且 enabled === true 时，自动 scrollTop = scrollHeight；
 * 2) 用户向上滚轮且未到底 → setEnabled(false)；
 * 3) 用户向下滚轮且到底 → setEnabled(true)。
 *
 * 关键坑位：程序化 scrollTop 写入会派发 onScroll，此时不应回写 enabled，
 * 否则会形成「scrollTo → onScroll → setEnabled(true) → re-render」回路。
 * 因此用 80ms 窗口屏蔽程序化滚动期内的 onScroll 事件。
 */
export function useAutoScrollToBottom(
  opts: UseAutoScrollToBottomOptions,
): UseAutoScrollToBottomReturn {
  const { containerRef, enabled, setEnabled, trigger } = opts;
  const programmaticScrollRef = useRef<boolean>(false);
  const programmaticScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    }, 80);
  }, [containerRef]);

  useEffect(() => {
    if (containerRef.current && enabled) {
      scrollToBottom();
    }
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

  const onScroll = useCallback(() => {
    if (!containerRef.current) return;
    if (programmaticScrollRef.current) return;
    // 纯 onScroll 事件不主动写 enabled（避免回路），仅 wheel 事件才回写
  }, [containerRef]);

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!containerRef.current) return;
      if (programmaticScrollRef.current) return;

      const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;

      if (event.deltaY < 0 && !isAtBottom) {
        setEnabled(false);
        return;
      }
      if (isAtBottom) {
        setEnabled(true);
      }
    },
    [containerRef, setEnabled],
  );

  return { onScroll, onWheel };
}

export default useAutoScrollToBottom;
