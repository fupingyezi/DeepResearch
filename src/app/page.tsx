'use client';

import ChatWindow from '@/components/chat-window/chat-window';
import ArtifactPanel from '@/components/process/artifact-panel';
import { useArtifactPanelStore } from '@/store';

export default function Home() {
  const isOpenArtifactPanel = useArtifactPanelStore((s) => s.isOpenArtifactPanel);

  return (
    <div className="flex h-screen w-full">
      {/* sider 占位（实际 sider 在 layout 里渲染，这里仅留视觉空白） */}
      <div className="h-screen w-[15%] shrink-0"></div>

      {/* chat 主体：未开 artifact 时占 70%，开了之后让出空间给右侧产物面板 */}
      <div
        className={`h-screen transition-all ${isOpenArtifactPanel ? 'min-w-0 flex-1' : 'w-[70%]'}`}
      >
        <ChatWindow
          emptyStateComponent={'Hi, Yezi!😃'}
          placeholder="只要不失去你的崇高，整个世界都会向你敞开。"
        />
      </div>

      {/* 右侧产物面板（仅在 isOpenArtifactPanel 为真时渲染） */}
      {isOpenArtifactPanel ? <ArtifactPanel /> : <div className="h-screen flex-1"></div>}
    </div>
  );
}
