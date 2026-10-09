'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';

import { useAuthStore } from '@/store/auth-store';

/**
 * 鉴权页布局（/login、/setup、/verify-email、/reset-password）：全屏、无侧边栏。
 * 已登录用户访问这些页面时自动跳回首页，避免停留在登录态下的鉴权页。
 * 例外：验证 / 重置页带一次性令牌，已登录用户点邮件链接也必须能完成核销，不跳转。
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const status = useAuthStore((s) => s.status);
  const isTokenPage = pathname === '/verify-email' || pathname === '/reset-password';

  useEffect(() => {
    if (status === 'authenticated' && !isTokenPage) {
      router.replace('/');
    }
  }, [status, router, isTokenPage]);

  return <>{children}</>;
}
