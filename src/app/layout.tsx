import './globals.css';
import Sider from '@/components/sider/sider';
import { initialDB } from '@/lib/db';

// 初始化数据库
try {
  await initialDB();
  console.log('Database initialized successfully');
} catch (error) {
  console.error('Database initialization failed:', error);
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="flex overflow-hidden">
        <Sider />
        {/* chat 主体（页面内自带 ArtifactPanel） */}
        {children}
      </body>
    </html>
  );
}
