'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import { AuthRequestError, resetPassword } from '@/utils/auth/client';

type Status = 'form' | 'success' | 'error';

function ResetPasswordInner() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [status, setStatus] = useState<Status>('form');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      setMessage('密码至少 8 位');
      return;
    }
    if (password !== confirm) {
      setMessage('两次输入的密码不一致');
      return;
    }
    setLoading(true);
    try {
      await resetPassword(token, password);
      setStatus('success');
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof AuthRequestError ? err.message : '重置失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen w-full items-center justify-center bg-[#f9fafb]">
      <div className="w-[380px] rounded-2xl border border-[#e5e7eb] bg-white p-8 text-center shadow-[0_8px_30px_rgba(16,24,40,0.08)]">
        <h1 className="text-[20px] font-semibold text-[#111827]">重置密码</h1>

        {status === 'form' && (
          <form onSubmit={submit} className="mt-5 flex flex-col gap-3 text-left">
            <input
              type="password"
              placeholder="新密码（至少 8 位）"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              className="h-11 rounded-xl border border-[#e5e7eb] bg-white px-4 text-[14px] transition-colors outline-none focus:border-[#14b8a6]"
            />
            <input
              type="password"
              placeholder="再次输入新密码"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              className="h-11 rounded-xl border border-[#e5e7eb] bg-white px-4 text-[14px] transition-colors outline-none focus:border-[#14b8a6]"
            />
            {message && <p className="text-[13px] text-[#dc2626]">{message}</p>}
            <button
              type="submit"
              disabled={loading || !token}
              className="h-11 rounded-xl bg-[#0f766e] text-[14px] font-medium text-white transition-all hover:bg-[#0d655e] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? '请稍候…' : '重置密码'}
            </button>
          </form>
        )}

        {status === 'success' && (
          <>
            <p className="mt-4 text-[14px] text-[#0f766e]">密码已重置，请用新密码登录</p>
            <Link
              href="/login"
              className="mt-6 inline-block h-10 rounded-xl bg-[#0f766e] px-6 text-[14px] leading-10 font-medium text-white transition-all hover:bg-[#0d655e]"
            >
              去登录
            </Link>
          </>
        )}

        {status === 'error' && (
          <>
            <p className="mt-4 text-[14px] text-[#dc2626]">{message}</p>
            <Link
              href="/login"
              className="mt-6 inline-block h-10 rounded-xl bg-[#0f766e] px-6 text-[14px] leading-10 font-medium text-white transition-all hover:bg-[#0d655e]"
            >
              返回登录
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  // useSearchParams 需 Suspense 边界（构建期静态预渲染约束）
  return (
    <Suspense fallback={null}>
      <ResetPasswordInner />
    </Suspense>
  );
}
