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

/**
 * 单个对话的运行态（按 sessionId 分桶）。
 *
 * 多对话并行的真相源：每个对话独立持有自己的消息、运行状态与 abort 句柄，
 * 互不覆盖。顶层的 current* 字段是「当前查看对话」对本桶的投影，仅用于让既有
 * 视图组件（ChatWindow / 消息列表）零改动地继续读取当前对话数据。
 */
export type SessionRunStatus = 'idle' | 'running' | 'done' | 'error';

export interface SessionRuntime {
  messages: ChatMessageType[];
  status: SessionRunStatus;
  abortController: AbortController | null;
  /** 最近一次活跃时间（毫秒），用于排序/调试。 */
  lastActiveAt: number;
}

function createSessionRuntime(messages: ChatMessageType[] = []): SessionRuntime {
  return { messages, status: 'idle', abortController: null, lastActiveAt: Date.now() };
}

export interface ChatSessionState {
  // ---- 会话 & 消息 ----
  // current* 为「当前查看对话」对 sessionRuntimes[currentSessionId] 的投影。
  isChating: boolean;
  shouldAutoScroll: boolean;
  chatSessions: ChatSessionType[];
  currentSessionId: UUIDTypes;
  currentMessages: ChatMessageType[];
  currentAbortController: AbortController | null;

  // ---- 多对话并行：按 sessionId 分桶的运行态（真相源）----
  sessionRuntimes: Record<string, SessionRuntime>;

  // ---- 产物面板 ----
  isOpenArtifactPanel: boolean;
  currentArtifact: ArtifactPanelState['currentArtifact'];

  // ---- actions（当前视图，投影自当前桶）----
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

  // ---- actions（按 sessionId 分桶，供 SSE handler 写回，绝不误伤当前视图）----
  /** 写入某对话的消息；若该对话正被查看则同步投影到 current*。 */
  setSessionMessages: (sessionId: string, messages: ChatMessageType[]) => void;
  /** 设置某对话运行状态；若为当前对话则同步 isChating 投影。 */
  setSessionStatus: (sessionId: string, status: SessionRunStatus) => void;
  /** 设置某对话 abort 句柄；若为当前对话则同步投影。 */
  setSessionAbortController: (sessionId: string, controller: AbortController | null) => void;
  /** 读取某对话运行态（无则返回 null）。 */
  getSessionRuntime: (sessionId: string) => SessionRuntime | null;
  /** 新建对话 START 后把临时 sessionId 桶迁移到真实 sessionId 桶。 */
  migrateSessionRuntime: (fromSessionId: string, toSessionId: string) => void;
  /** 中止指定对话（不影响其它对话）。 */
  abortSession: (sessionId: string) => void;

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
  immer((set, get) => ({
    // ---- 会话 & 消息 初始值 ----
    isChating: false,
    shouldAutoScroll: false,
    chatSessions: [],
    currentSessionId: '',
    currentMessages: [],
    currentAbortController: null,

    // ---- 多对话并行 初始值 ----
    sessionRuntimes: {},

    // ---- 产物面板 初始值 ----
    isOpenArtifactPanel: false,
    currentArtifact: null,

    // ---- 会话 actions ----
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

          // 删除对话时清理其运行桶（中止其可能仍在跑的 run）。
          const runtime = state.sessionRuntimes[String(chatSession.id)];
          if (runtime?.abortController) runtime.abortController.abort();
          delete state.sessionRuntimes[String(chatSession.id)];

          return {
            chatSessions: filteredSessions,
            currentSessionId: newcurrentSessionId,
            currentMessages: newCurrentMessages,
          };
        }
        return {};
      }),

    // 切换当前查看对话：从目标桶恢复投影（消息 + 运行态），不触碰其它对话的桶。
    setCurrentSessionId: (sessionId) =>
      set((state) => {
        state.currentSessionId = sessionId;
        const runtime = state.sessionRuntimes[String(sessionId)];
        if (runtime) {
          // 已跑完（done）的对话被查看后，清除「未读绿点」标识（回到 idle）。
          if (runtime.status === 'done') runtime.status = 'idle';
          state.currentMessages = runtime.messages;
          state.isChating = runtime.status === 'running';
          state.currentAbortController = runtime.abortController;
        } else {
          // 无桶（如全新对话）：清空当前视图，运行态归零。
          state.currentMessages = [];
          state.isChating = false;
          state.currentAbortController = null;
        }
        // 切换会话时自动关闭产物面板
        state.isOpenArtifactPanel = false;
        state.currentArtifact = null;
      }),

    // 写当前视图消息：同时写入当前对话的桶，保持投影与真相源一致。
    setCurrentMessages: (chatMessages) =>
      set((state) => {
        state.currentMessages = chatMessages;
        const sid = String(state.currentSessionId);
        if (sid) {
          const runtime = state.sessionRuntimes[sid] ?? createSessionRuntime();
          runtime.messages = chatMessages;
          runtime.lastActiveAt = Date.now();
          state.sessionRuntimes[sid] = runtime;
        }
      }),

    updateCurrentMessages: (chatMessages) =>
      set((state) => {
        const next = Array.isArray(chatMessages)
          ? [...state.currentMessages, ...chatMessages]
          : [...state.currentMessages, chatMessages];
        state.currentMessages = next;
        const sid = String(state.currentSessionId);
        if (sid) {
          const runtime = state.sessionRuntimes[sid] ?? createSessionRuntime();
          runtime.messages = next;
          runtime.lastActiveAt = Date.now();
          state.sessionRuntimes[sid] = runtime;
        }
      }),

    setAbortController: (abortController) =>
      set((state) => {
        state.currentAbortController = abortController;
        const sid = String(state.currentSessionId);
        if (sid) {
          const runtime = state.sessionRuntimes[sid] ?? createSessionRuntime();
          runtime.abortController = abortController;
          state.sessionRuntimes[sid] = runtime;
        }
      }),

    abortCurrentChat: () =>
      set((state) => {
        if (state.currentAbortController) {
          state.currentAbortController.abort();
          state.currentAbortController = null;
          state.isChating = false;
          const sid = String(state.currentSessionId);
          const runtime = sid ? state.sessionRuntimes[sid] : undefined;
          if (runtime) {
            runtime.abortController = null;
            runtime.status = 'idle';
          }
        }
      }),

    // ---- 按 sessionId 分桶 actions ----
    setSessionMessages: (sessionId, messages) =>
      set((state) => {
        const sid = String(sessionId);
        const runtime = state.sessionRuntimes[sid] ?? createSessionRuntime();
        runtime.messages = messages;
        runtime.lastActiveAt = Date.now();
        state.sessionRuntimes[sid] = runtime;
        // 仅当该对话正被查看时才投影到当前视图，避免污染他对话。
        if (sid === String(state.currentSessionId)) {
          state.currentMessages = messages;
        }
      }),

    setSessionStatus: (sessionId, status) =>
      set((state) => {
        const sid = String(sessionId);
        const runtime = state.sessionRuntimes[sid] ?? createSessionRuntime();
        // 绿点语义 = 「非当前对话跑完的未读提醒」：若跑完时用户正看着该对话，
        // 直接落 idle（无需未读提醒），避免当前对话跑完仍挂绿点。
        const isViewing = sid === String(state.currentSessionId);
        runtime.status = status === 'done' && isViewing ? 'idle' : status;
        runtime.lastActiveAt = Date.now();
        state.sessionRuntimes[sid] = runtime;
        if (isViewing) {
          state.isChating = runtime.status === 'running';
        }
      }),

    setSessionAbortController: (sessionId, controller) =>
      set((state) => {
        const sid = String(sessionId);
        const runtime = state.sessionRuntimes[sid] ?? createSessionRuntime();
        runtime.abortController = controller;
        state.sessionRuntimes[sid] = runtime;
        if (sid === String(state.currentSessionId)) {
          state.currentAbortController = controller;
        }
      }),

    getSessionRuntime: (sessionId) => get().sessionRuntimes[String(sessionId)] ?? null,

    migrateSessionRuntime: (fromSessionId, toSessionId) =>
      set((state) => {
        const from = String(fromSessionId);
        const to = String(toSessionId);
        if (from === to) return;
        const runtime = state.sessionRuntimes[from];
        if (!runtime) return;
        state.sessionRuntimes[to] = runtime;
        delete state.sessionRuntimes[from];
        // 若当前正看着临时 id 桶，把当前 id 也切到真实 id（视图无缝衔接）。
        if (String(state.currentSessionId) === from) {
          state.currentSessionId = toSessionId;
        }
      }),

    abortSession: (sessionId) =>
      set((state) => {
        const sid = String(sessionId);
        const runtime = state.sessionRuntimes[sid];
        if (runtime?.abortController) {
          runtime.abortController.abort();
          runtime.abortController = null;
          runtime.status = 'idle';
        }
        if (sid === String(state.currentSessionId)) {
          state.currentAbortController = null;
          state.isChating = false;
        }
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
