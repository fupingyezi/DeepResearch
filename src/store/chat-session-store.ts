import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { ChatMessageType, ChatSessionType } from '@/types';
import { UUIDTypes } from 'uuid';

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
}

export interface ChatSessionState {
  // ---- 会话 & 消息 ----
  isChating: boolean;
  shouldAutoScroll: boolean;
  chatSessions: ChatSessionType[];
  currentSessionId: UUIDTypes;
  currentMessages: ChatMessageType[];
  currentAbortController: AbortController | null;

  // ---- 产物面板 ----
  isOpenArtifactPanel: boolean;
  currentArtifact: ArtifactPanelState['currentArtifact'];

  // ---- actions ----
  setIsChating: (isChating: boolean) => void;
  setShouldAutoScroll: (shouldAutoScroll: boolean) => void;
  intialChatSessions: (chatSessions: ChatSessionType[]) => void;
  addChatSession: (chatSession: ChatSessionType) => void;
  updateChatSession: (chatSession: ChatSessionType | null, op: 'edit' | 'delete') => void;
  setCurrentSessionId: (sessionId: UUIDTypes) => void;
  setCurrentMessages: (chatMessages: ChatMessageType[]) => void;
  updateCurrentMessages: (ChatMessages: ChatMessageType | ChatMessageType[]) => void;
  setAbortController: (controller: AbortController | null) => void;
  abortCurrentChat: () => void;

  setIsOpenArtifactPanel: (open: boolean) => void;
  openArtifact: (artifact: {
    sessionId?: string;
    messageId?: string;
    title?: string;
    report: string;
  }) => void;
  closeArtifact: () => void;
}

const useChatSessionStore = create<ChatSessionState>()(
  immer((set) => ({
    // ---- 会话 & 消息 初始值 ----
    isChating: false,
    shouldAutoScroll: false,
    chatSessions: [],
    currentSessionId: '',
    currentMessages: [],
    currentAbortController: null,

    // ---- 产物面板 初始值 ----
    isOpenArtifactPanel: false,
    currentArtifact: null,

    // ---- 会话 actions（无 immer 差异，保持原逻辑）----
    setIsChating: (isChating) => set(() => ({ isChating })),

    setShouldAutoScroll: (shouldAutoScroll) =>
      set((state) => (state.shouldAutoScroll === shouldAutoScroll ? {} : { shouldAutoScroll })),

    intialChatSessions: (chatSessions) => set(() => ({ chatSessions })),

    addChatSession: (chatSession) =>
      set((state) => {
        let hasSession = false;
        for (let i = 0; i < state.chatSessions.length; i++) {
          if (state.chatSessions[i].id === chatSession.id) {
            hasSession = true;
            break;
          }
        }
        if (!hasSession) {
          return { chatSessions: [chatSession, ...state.chatSessions] };
        }
        return {};
      }),

    updateChatSession: (chatSession, op) =>
      set((state) => {
        if (!chatSession) return {};
        if (op === 'edit') {
          const otherSessions = state.chatSessions.filter(
            (session) => session.id !== chatSession.id,
          );
          return { chatSessions: [chatSession, ...otherSessions] };
        } else if (op === 'delete') {
          const filteredSessions = state.chatSessions.filter(
            (session) => session.id !== chatSession.id,
          );

          let newcurrentSessionId = state.currentSessionId;
          let newCurrentMessages: ChatMessageType[] = state.currentMessages;

          if (state.currentSessionId === chatSession.id) {
            newcurrentSessionId = '';
            newCurrentMessages = [];
          }

          return {
            chatSessions: filteredSessions,
            currentSessionId: newcurrentSessionId,
            currentMessages: newCurrentMessages,
          };
        }
        return {};
      }),

    setCurrentSessionId: (sessionId) =>
      set((state) => {
        state.currentSessionId = sessionId;
        // 切换会话时自动关闭产物面板
        state.isOpenArtifactPanel = false;
        state.currentArtifact = null;
      }),

    setCurrentMessages: (chatMessages) => set(() => ({ currentMessages: chatMessages })),

    updateCurrentMessages: (chatMessages) =>
      set((state) => {
        if (Array.isArray(chatMessages)) {
          return { currentMessages: [...state.currentMessages, ...chatMessages] };
        } else {
          return { currentMessages: [...state.currentMessages, chatMessages] };
        }
      }),

    setAbortController: (abortController) =>
      set(() => ({ currentAbortController: abortController })),

    abortCurrentChat: () =>
      set((state) => {
        if (state.currentAbortController) {
          state.currentAbortController.abort();
          return { currentAbortController: null, isChating: false };
        }
        return {};
      }),

    // ---- 产物面板 actions ----
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

export default useChatSessionStore;
