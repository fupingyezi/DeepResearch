'use client';

import { useEffect, type RefObject } from 'react';

/**
 * useTextareaAutoHeight
 *
 * value 变化时把 textarea 高度重置为 'auto' 后再设为 scrollHeight（capped 到 maxHeightPx）。
 *
 * 关键不变量：读 scrollHeight + 写 height 收敛到一次 layout 帧内，避免抖动。
 */
export function useTextareaAutoHeight(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxHeightPx = 100,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, maxHeightPx) + 'px';
  }, [ref, value, maxHeightPx]);
}

export default useTextareaAutoHeight;
