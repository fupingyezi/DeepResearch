'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import EmailVerifyBanner from '@/components/auth/email-verify-banner';
import Sider from '@/components/sider/sider';
import { useAuthStore } from '@/store/auth-store';
import { AgentEventProvider } from '@/events/context';

/**
 * 应用主区布局：渲染侧边栏 + 业务页面。
 * 客户端兜底守卫：未认证时跳转 /login（服务端 middleware 已做 cookie 层拦截，
 * 这里防止认证态在客户端失效后仍停留在应用内）。
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.replace('/login');
    }
  }, [status, router]);

  // 认证状态确定为已登录前不渲染主体，避免未授权内容闪现
  if (status !== 'authenticated') {
    return null;
  }

  return (
    <AgentEventProvider>
      {user && !user.emailVerified && <EmailVerifyBanner />}
      <Sider />
      {children}
    </AgentEventProvider>
  );
}
