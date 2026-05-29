import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**
 * Artifact / 产物面板状态
 *
 * 仅承载"右侧产物面板"的展示状态：当前打开的产物（report markdown）+ 是否展开。
 *
 * `messageId` 为 uuid 字符串（与 ChatMessageType.id 同构）。
 */
export interface ArtifactPanelState {
  /** 是否打开右侧产物面板 */
  isOpenArtifactPanel: boolean;
  /** 当前展示的产物：来源消息 id + 内容 */
  currentArtifact: {
    sessionId?: string;
    messageId?: string;
    title?: string;
    report: string;
  } | null;
  setIsOpenArtifactPanel: (open: boolean) => void;
  openArtifact: (artifact: {
    sessionId?: string;
    messageId?: string;
    title?: string;
    report: string;
  }) => void;
  closeArtifact: () => void;
}

const useArtifactPanelStore = create<ArtifactPanelState>()(
  immer((set) => ({
    isOpenArtifactPanel: false,
    currentArtifact: null,
    setIsOpenArtifactPanel: (open) =>
      set((state) => {
        if (state.isOpenArtifactPanel === open) return;
        state.isOpenArtifactPanel = open;
      }),
    openArtifact: (artifact) =>
      set((state) => {
        state.isOpenArtifactPanel = true;
        state.currentArtifact = {
          sessionId: artifact.sessionId,
          messageId: artifact.messageId,
          title: artifact.title,
          report: artifact.report,
        };
      }),
    closeArtifact: () =>
      set((state) => {
        state.isOpenArtifactPanel = false;
        state.currentArtifact = null;
      }),
  })),
);

export default useArtifactPanelStore;
