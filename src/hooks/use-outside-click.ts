'use client';

import { useEffect } from 'react';

/**
 * useOutsideClick
 *
 * 当 enabled === true 时，在 document 上挂一个 click 监听；
 * 任何 click 触发后调用 handler（调用方自行判断是否真的"在外侧"）。
 *
 * 用于 Popover / Menu 等"点击外部关闭"场景。
 */
export function useOutsideClick(enabled: boolean, handler: (event: MouseEvent) => void): void {
  useEffect(() => {
    if (!enabled) return;
    const onClick = (event: MouseEvent) => handler(event);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('click', onClick);
    };
  }, [enabled, handler]);
}

export default useOutsideClick;
