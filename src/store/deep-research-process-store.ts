import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

/**
 * Artifact / 产物面板状态
 *
 * 改造说明（与 deer-flow 对齐）：
 *   - 工作流（任务/进度/中断）一律内联在 chat 气泡的 ResearchTimeline 中渲染；
 *   - 这里仅承载"右侧产物面板"的展示状态：当前打开的产物（report）+ 是否展开。
 *
 * 历史的 simpleAnalysis / tasks / status / interrupt 等字段都已迁移到
 * `ChatMessageType.timeline`，不再放入全局 store。
 */
export interface ArtifactPanelState {
  /** 是否打开右侧产物面板 */
  isOpenArtifactPanel: boolean;
  /** 当前展示的产物：来源消息 id + 内容 */
  currentArtifact: {
    sessionId?: string;
    messageId?: number;
    title?: string;
    report: string;
  } | null;
  setIsOpenArtifactPanel: (open: boolean) => void;
  openArtifact: (artifact: {
    sessionId?: string;
    messageId?: number;
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
