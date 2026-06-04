'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';

import { useAuth } from '@/runtime/context/auth-provider';
import {
  AuthRequestError,
  fetchSetupStatus,
  login as loginRequest,
  register as registerRequest,
} from '@/utils/auth/client';

type Mode = 'login' | 'register';

export default function LoginPage() {
  const router = useRouter();
  const { applyUser } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // 无 admin 时引导到首启设置页
  useEffect(() => {
    fetchSetupStatus().then((needsSetup) => {
      if (needsSetup) router.replace('/setup');
    });
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const user =
        mode === 'login'
          ? await loginRequest(email, password)
          : await registerRequest(email, password);
      applyUser(user);
      // 硬导航整页跳转：确保 HttpOnly cookie 已写入、middleware 重新放行 /，
      // 规避软导航命中 Router 缓存的"未登录重定向"导致 URL 停留 /login。
      window.location.assign('/');
    } catch (err) {
      setError(err instanceof AuthRequestError ? err.message : 'Network error, please try again');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen w-full items-center justify-center bg-[#f9fafb]">
      <div className="w-[380px] rounded-2xl border border-[#e5e7eb] bg-white p-8 shadow-[0_8px_30px_rgba(16,24,40,0.08)]">
        <div className="mb-6 flex flex-col items-center gap-2">
          <Image src="/四叶草.svg" alt="logo" width={48} height={48} className="rounded-xl" />
          <h1 className="text-[20px] font-semibold text-[#111827]">
            {mode === 'login' ? '欢迎回来' : '创建账号'}
          </h1>
          <p className="text-[13px] text-[#9ca3af]">mini-DeepResearch</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="email"
            placeholder="邮箱"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="h-11 rounded-xl border border-[#e5e7eb] bg-white px-4 text-[14px] transition-colors outline-none focus:border-[#14b8a6]"
          />
          <input
            type="password"
            placeholder="密码（至少 8 位）"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            className="h-11 rounded-xl border border-[#e5e7eb] bg-white px-4 text-[14px] transition-colors outline-none focus:border-[#14b8a6]"
          />

          {error && <p className="text-[13px] text-[#dc2626]">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="mt-1 h-11 rounded-xl bg-[#0f766e] text-[14px] font-medium text-white transition-all hover:bg-[#0d655e] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? '请稍候…' : mode === 'login' ? '登录' : '注册并登录'}
          </button>
        </form>

        <div className="mt-5 text-center text-[13px] text-[#9ca3af]">
          {mode === 'login' ? (
            <>
              还没有账号？
              <button
                type="button"
                onClick={() => {
                  setMode('register');
                  setError('');
                }}
                className="ml-1 cursor-pointer font-medium text-[#0f766e] hover:underline"
              >
                注册
              </button>
            </>
          ) : (
            <>
              已有账号？
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setError('');
                }}
                className="ml-1 cursor-pointer font-medium text-[#0f766e] hover:underline"
              >
                去登录
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
