'use client';

import { ToolOutlined } from '@ant-design/icons';

/**
 * 设置弹窗中尚未实现的 Tab（外观/通知/记忆/工具/技能/关于）的统一占位空态。
 */
export function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="flex h-full flex-col">
      <h2 className="mb-6 text-[18px] font-semibold text-[#111827]">{title}</h2>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[#9ca3af]">
        <ToolOutlined style={{ fontSize: 40 }} />
        <p className="text-[14px]">功能开发中</p>
      </div>
    </div>
  );
}
