'use client';

import { CloseOutlined, FileTextOutlined } from '@ant-design/icons';
import CustomMarkdown from '../markdown/custom-markdown';
import { useArtifactPanelStore } from '@/store';

/**
 * 右侧 Artifact 产物面板
 */
const ArtifactPanel = () => {
  const isOpen = useArtifactPanelStore((s) => s.isOpenArtifactPanel);
  const currentArtifact = useArtifactPanelStore((s) => s.currentArtifact);
  const closeArtifact = useArtifactPanelStore((s) => s.closeArtifact);

  if (!isOpen || !currentArtifact) return null;

  return (
    // 外层容器：左侧一条分隔线 + 浅灰底色 + 内边距，承载浮窗卡片
    <div className="flex h-screen w-[44%] max-w-[680px] min-w-[440px] shrink-0 flex-col border-l border-[#e5e7eb] bg-[#f3f4f6] p-3">
      {/* 浮窗卡片：白底 + 圆角 + 边框 + 阴影，悬浮在分隔区背景之上 */}
      <div className="flex h-full w-full min-w-0 flex-col overflow-hidden rounded-2xl border border-[#e5e7eb] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_8px_24px_rgba(16,24,40,0.06)]">
        {/* header */}
        <div className="flex shrink-0 items-center justify-between border-b border-[#f0f1f3] px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-600">
              <FileTextOutlined />
            </span>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[15px] font-semibold text-gray-800">
                {currentArtifact.title || '研究报告'}
              </span>
              <span className="text-[11px] text-gray-400">研究报告 · Markdown</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => closeArtifact()}
            aria-label="关闭产物面板"
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <CloseOutlined />
          </button>
        </div>

        {/* body */}
        <div className="scrollbar-slim min-w-0 flex-1 overflow-y-auto px-7 py-6">
          {currentArtifact.report ? (
            <div className="min-w-0 wrap-break-word">
              <CustomMarkdown content={currentArtifact.report} />
            </div>
          ) : (
            <div className="text-sm text-gray-400">该产物暂无内容</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ArtifactPanel;
