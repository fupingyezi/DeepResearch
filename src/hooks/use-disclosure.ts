'use client';

import { useCallback, useState } from 'react';

export interface UseDisclosureReturn {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setIsOpen: (next: boolean) => void;
}

/**
 * useDisclosure
 *
 * 受控/非受控的 open/close 开关：返回稳定引用的 open/close/toggle/setIsOpen，
 * 用于折叠面板、Popover、抽屉、模态框等"展开-收起"型 UI 状态。
 */
export function useDisclosure(initial = false): UseDisclosureReturn {
  const [isOpen, setIsOpen] = useState<boolean>(initial);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((v) => !v), []);
  return { isOpen, open, close, toggle, setIsOpen };
}

export default useDisclosure;
