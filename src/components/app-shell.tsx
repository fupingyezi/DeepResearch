'use client';

import { usePathname } from 'next/navigation';

import Sider from '@/components/sider/sider';

const FULLSCREEN_ROUTES = ['/login', '/setup'];

/**
 * 应用外壳：登录/设置等全屏路由不渲染侧边栏，其余路由渲染 Sider + 主体。
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isFullscreen = FULLSCREEN_ROUTES.includes(pathname);

  if (isFullscreen) {
    return <>{children}</>;
  }

  return (
    <>
      <Sider />
      {children}
    </>
  );
}
