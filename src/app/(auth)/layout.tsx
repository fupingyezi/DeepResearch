'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { useAuthStore } from '@/store/auth-store';

/**
 * 鉴权页布局（/login、/setup）：全屏、无侧边栏。
 * 已登录用户访问这些页面时自动跳回首页，避免停留在登录态下的鉴权页。
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const status = useAuthStore((s) => s.status);

  useEffect(() => {
    if (status === 'authenticated') {
      router.replace('/');
    }
  }, [status, router]);

  return <>{children}</>;
}
