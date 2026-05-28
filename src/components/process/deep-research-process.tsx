"use client";

import { CloseOutlined, FileTextOutlined } from "@ant-design/icons";
import { Button } from "antd";
import CustomMarkdown from "../markdown/custom-markdown";
import { useArtifactPanelStore } from "@/store";

/**
 * 右侧 Artifact 产物面板（对齐 deer-flow 的 ArtifactFileDetail）。
 *
 * 仅承担"产物展示"职责：
 *   - 不再渲染过程（plan/tasks/interrupt）——这些已内联在 chat 气泡的 ResearchTimeline；
 *   - 展示由 chat 气泡里的"查看产物"按钮触发的 currentArtifact（一般是 markdown report）；
 *   - 关闭按钮把面板收起。
 */
const ArtifactPanel = () => {
  const isOpen = useArtifactPanelStore((s) => s.isOpenArtifactPanel);
  const currentArtifact = useArtifactPanelStore((s) => s.currentArtifact);
  const closeArtifact = useArtifactPanelStore((s) => s.closeArtifact);

  if (!isOpen || !currentArtifact) return null;

  return (
    <div className="h-screen w-[45%] min-w-[420px] max-w-3xl flex flex-col border-l-2 border-[#f3f3f3] bg-white">
      {/* header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#f3f3f3]">
        <div className="flex items-center gap-2 min-w-0">
          <FileTextOutlined className="text-blue-500 shrink-0" />
          <span className="font-medium text-gray-800 truncate">
            {currentArtifact.title || "研究报告"}
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
          <div className="text-gray-400 text-sm">该产物暂无内容</div>
        )}
      </div>
    </div>
  );
};

export default ArtifactPanel;
