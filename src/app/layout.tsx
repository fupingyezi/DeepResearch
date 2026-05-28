import "./globals.css";
import Sider from "@/components/sider/sider";
import ArtifactPanel from "@/components/process/deep-research-process";
import { initialDB } from "@/lib/db";

// 初始化数据库
try {
  await initialDB();
  console.log("Database initialized successfully");
} catch (error) {
  console.error("Database initialization failed:", error);
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
        {/* chat 主体 */}
        {children}
        {/* 右侧产物面板（仅在 isOpenArtifactPanel 为真时渲染） */}
        <ArtifactPanel />
      </body>
    </html>
  );
}
