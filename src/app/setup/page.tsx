'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';

import { useAuth } from '@/runtime/context/auth-provider';
import { AuthRequestError, initializeAdmin } from '@/utils/auth/client';

export default function SetupPage() {
  const router = useRouter();
  const { applyUser } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setLoading(true);
    try {
      const admin = await initializeAdmin(email, password);
      applyUser(admin);
      router.replace('/');
    } catch (err) {
      setError(err instanceof AuthRequestError ? err.message : 'Network error, please try again');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen w-full items-center justify-center bg-[#f9fafb]">
      <div className="w-[420px] rounded-2xl border border-[#e5e7eb] bg-white p-8 shadow-[0_8px_30px_rgba(16,24,40,0.08)]">
        <div className="mb-6 flex flex-col items-center gap-2">
          <Image src="/四叶草.svg" alt="logo" width={48} height={48} className="rounded-xl" />
          <h1 className="text-[20px] font-semibold text-[#111827]">初始化管理员</h1>
          <p className="text-center text-[13px] text-[#9ca3af]">
            这是系统首次启动，请创建第一个管理员账号。
            <br />
            存量历史对话将归属于该账号。
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="email"
            placeholder="管理员邮箱"
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
          <input
            type="password"
            placeholder="确认密码"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
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
            {loading ? '创建中…' : '创建管理员'}
          </button>
        </form>
      </div>
    </div>
  );
}
