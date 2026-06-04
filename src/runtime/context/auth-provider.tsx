'use client';

import { useEffect } from 'react';

import { useAuthStore } from '@/store/auth-store';
import { fetchMe, logout as logoutRequest } from '@/utils/auth/client';
import type { UserResponse } from '@deerflow-harness/auth/types';

/**
 * AuthProvider：应用挂载时拉取 /api/auth/me 初始化登录态。
 * 受保护页面由 middleware 兜底，这里只负责把当前用户灌入 auth store。
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const setUser = useAuthStore((s) => s.setUser);
  const setStatus = useAuthStore((s) => s.setStatus);

  useEffect(() => {
    let active = true;
    setStatus('loading');
    fetchMe().then((user) => {
      if (!active) return;
      setUser(user);
      setStatus(user ? 'authenticated' : 'unauthenticated');
    });
    return () => {
      active = false;
    };
  }, [setUser, setStatus]);

  return <>{children}</>;
}

export function useAuth() {
  const user = useAuthStore((s) => s.user);
  const status = useAuthStore((s) => s.status);
  const setUser = useAuthStore((s) => s.setUser);
  const setStatus = useAuthStore((s) => s.setStatus);

  const applyUser = (next: UserResponse) => {
    setUser(next);
    setStatus('authenticated');
  };

  const logout = async () => {
    await logoutRequest();
    setUser(null);
    setStatus('unauthenticated');
    window.location.href = '/login';
  };

  return { user, status, applyUser, logout };
}
