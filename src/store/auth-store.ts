import { create } from 'zustand';

import type { UserResponse } from '@deerflow-harness/auth/types';

export type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'unauthenticated';

interface AuthState {
  user: UserResponse | null;
  status: AuthStatus;
  setUser: (user: UserResponse | null) => void;
  setStatus: (status: AuthStatus) => void;
}

/**
 * 前端鉴权状态。user/status 由 AuthProvider 在挂载时通过 /api/auth/me 拉取并维护，
 * 登录/登出后同步更新。
 */
export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  status: 'idle',
  setUser: (user) => set({ user }),
  setStatus: (status) => set({ status }),
}));
