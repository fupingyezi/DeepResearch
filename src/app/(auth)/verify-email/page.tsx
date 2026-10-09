'use client';

import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import { AuthRequestError, verifyEmail } from '@/utils/auth/client';

type Status = 'loading' | 'success' | 'error';

function VerifyEmailInner() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [status, setStatus] = useState<Status>('loading');
  const [message, setMessage] = useState('');

  // 令牌核销单次有效：重复进入本页会因 used_at 置位而失败，属预期
  useEffect(() => {
    if (!token) {
      setStatus('error');
      setMessage('缺少令牌参数，请从验证邮件里的链接进入');
      return;
    }
    verifyEmail(token)
      .then(() => setStatus('success'))
      .catch((err) => {
        setStatus('error');
        setMessage(err instanceof AuthRequestError ? err.message : '验证失败，请重试');
      });
  }, [token]);

  return (
    <div className="flex h-screen w-full items-center justify-center bg-[#f9fafb]">
      <div className="w-[380px] rounded-2xl border border-[#e5e7eb] bg-white p-8 text-center shadow-[0_8px_30px_rgba(16,24,40,0.08)]">
        <h1 className="text-[20px] font-semibold text-[#111827]">邮箱验证</h1>
        {status === 'loading' && <p className="mt-4 text-[13px] text-[#9ca3af]">验证中…</p>}
        {status === 'success' && (
          <>
            <p className="mt-4 text-[14px] text-[#0f766e]">验证成功，你的邮箱已通过验证</p>
            <Link
              href="/"
              className="mt-6 inline-block h-10 rounded-xl bg-[#0f766e] px-6 text-[14px] leading-10 font-medium text-white transition-all hover:bg-[#0d655e]"
            >
              进入应用
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

export default function VerifyEmailPage() {
  // useSearchParams 需 Suspense 边界（构建期静态预渲染约束）
  return (
    <Suspense fallback={null}>
      <VerifyEmailInner />
    </Suspense>
  );
}
