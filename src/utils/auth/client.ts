/**
 * 前端调用 /api/auth/* 的封装。所有请求带 credentials:'include' 以收发 HttpOnly cookie。
 *
 * 失败时抛出携带 code 的 AuthRequestError，调用方据 code/message 做文案提示。
 */

import type { UserResponse } from '@deerflow-harness/auth/types';

export class AuthRequestError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = typeof data?.code === 'string' ? data.code : 'UNKNOWN';
    const message = typeof data?.message === 'string' ? data.message : 'Request failed';
    throw new AuthRequestError(code, message);
  }
  return data as T;
}

export async function login(email: string, password: string): Promise<UserResponse> {
  return postJson<UserResponse>('/api/auth/login', { email, password });
}

/** 体验账号一键登录：凭证在服务器 env，前端只发空请求体 */
export async function demoLogin(): Promise<UserResponse> {
  return postJson<UserResponse>('/api/auth/demo-login', {});
}

export async function register(email: string, password: string): Promise<UserResponse> {
  return postJson<UserResponse>('/api/auth/register', { email, password });
}

export async function initializeAdmin(email: string, password: string): Promise<UserResponse> {
  return postJson<UserResponse>('/api/auth/initialize', { email, password });
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
  newEmail?: string,
): Promise<void> {
  await postJson('/api/auth/change-password', {
    current_password: currentPassword,
    new_password: newPassword,
    ...(newEmail ? { new_email: newEmail } : {}),
  });
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
}

export async function fetchMe(): Promise<UserResponse | null> {
  const res = await fetch('/api/auth/me', { credentials: 'include' });
  if (!res.ok) return null;
  return (await res.json()) as UserResponse;
}

export interface SetupStatus {
  needs_setup: boolean;
  /** 体验账号入口：enabled 时登录页显示"一键体验"按钮 */
  demo_login: {
    enabled: boolean;
    /** 展示用邮箱；未配置时为 null（密码永远不下发） */
    email: string | null;
  };
}

export async function fetchSetupStatus(): Promise<SetupStatus> {
  const res = await fetch('/api/auth/setup-status', { credentials: 'include' });
  if (!res.ok) {
    return { needs_setup: false, demo_login: { enabled: false, email: null } };
  }
  const data = (await res.json()) as Partial<SetupStatus>;
  return {
    needs_setup: Boolean(data.needs_setup),
    demo_login: {
      enabled: Boolean(data.demo_login?.enabled),
      email: typeof data.demo_login?.email === 'string' ? data.demo_login.email : null,
    },
  };
}
