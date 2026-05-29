'use client';

import { CloseOutlined, FileTextOutlined } from '@ant-design/icons';
import { Button } from 'antd';
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
    <div className="flex h-screen w-[45%] max-w-3xl min-w-[420px] flex-col border-l-2 border-[#f3f3f3] bg-white">
      {/* header */}
      <div className="flex items-center justify-between border-b border-[#f3f3f3] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileTextOutlined className="shrink-0 text-blue-500" />
          <span className="truncate font-medium text-gray-800">
            {currentArtifact.title || '研究报告'}
          </span>
        </div>
        <Button
          type="text"
          icon={<CloseOutlined />}
          onClick={() => closeArtifact()}
          aria-label="关闭产物面板"
        />
      </div>

      {/* body */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {currentArtifact.report ? (
          <CustomMarkdown content={currentArtifact.report} />
        ) : (
          <div className="text-sm text-gray-400">该产物暂无内容</div>
        )}
      </div>
    </div>
  );
};

export default ArtifactPanel;
