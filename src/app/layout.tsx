import './globals.css';
import { AuthProvider } from '@/runtime/context/auth-provider';
import { initialDB } from '@/lib/db';

// 在模块加载时触发一次（fire-and-forget），不阻塞 layout 渲染。
// initialDB 内部用 globalThis 单例缓存，HMR / 多次 import 都只跑一次。
initialDB().catch((error) => {
  console.error('Database initialization failed:', error);
});

/**
 * 根布局：仅负责 html/body 骨架与全局 Provider 注入。
 * 侧边栏等应用外壳下沉到 (app)/layout，鉴权页外壳下沉到 (auth)/layout，
 * 由 Next.js Route Group 各自承担布局，互不干扰。
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="flex h-screen overflow-hidden bg-[#f9fafb] text-[#111827] antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
