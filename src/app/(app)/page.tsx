'use client';

import ChatWindow from '@/components/chat-window/chat-window';
import ArtifactPanel from '@/components/process/artifact-panel';
import { useArtifactPanelStore } from '@/store';

export default function Home() {
  const isOpenArtifactPanel = useArtifactPanelStore((s) => s.isOpenArtifactPanel);

  return (
    <div className="flex h-screen min-w-0 flex-1 bg-[#f9fafb]">
      {/* chat 主体：占据除右侧产物面板外的全部剩余空间 */}
      <div className="h-screen min-w-0 flex-1">
        <ChatWindow
          emptyStateComponent={'Hi, Good Luck!'}
          placeholder="只要不失去你的崇高，整个世界都会向你敞开。"
        />
      </div>

      {/* 右侧产物面板（仅在 isOpenArtifactPanel 为真时渲染） */}
      {isOpenArtifactPanel ? <ArtifactPanel /> : null}
    </div>
  );
}
