import './globals.css';
import Sider from '@/components/sider/sider';
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
        <Sider />
        {/* chat 主体（页面内自带 ArtifactPanel） */}
        {children}
      </body>
    </html>
  );
}
