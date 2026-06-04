import './globals.css';
import { AppShell } from '@/components/app-shell';
import { AuthProvider } from '@/runtime/context/auth-provider';
import { initialDB } from '@/lib/db';

// 在模块加载时触发一次（fire-and-forget），不阻塞 layout 渲染。
// initialDB 内部用 globalThis 单例缓存，HMR / 多次 import 都只跑一次。
initialDB().catch((error) => {
  console.error('Database initialization failed:', error);
});

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="flex h-screen overflow-hidden bg-[#f9fafb] text-[#111827] antialiased">
        <AuthProvider>
          <AppShell>{children}</AppShell>
        </AuthProvider>
      </body>
    </html>
  );
}
