'use client';

import { useEffect } from 'react';

import { useAuthStore } from '@/store/auth-store';
import { fetchMe, logout as logoutRequest } from '@/utils/auth/client';
import { onUnauthorized } from '@/utils/auth/unauthorized-event';
import type { UserResponse } from '@deerflow-harness/auth/types';

/**
 * AuthProvider：应用挂载时拉取 /api/auth/me 初始化登录态，并监听全局 401 事件
 * （业务 API 收到 401 = 会话被吊销/过期）清登录态跳登录页。
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

  useEffect(() => {
    return onUnauthorized(() => {
      // 只在已登录态响应；多请求并发 401 时首个事件已清态，后续 no-op
      if (useAuthStore.getState().status !== 'authenticated') return;
      setUser(null);
      setStatus('unauthenticated');
      // 硬导航：会话已死，SSE 泵等长连接一并随页面卸载中断
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    });
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
