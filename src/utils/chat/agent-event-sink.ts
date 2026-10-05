/**
 * agent-event-sink
 *
 * SessionStreamSink 注册表 —— 泵事件的 store 写入者（EventBus 的一等通配订阅者）。
 *
 * 职责反转：泵（AgentEventProvider）只负责 fetch + emit，本模块作为订阅者把
 * 事件聚合成 store 数据（占位消息、START id 迁移、rAF 合帧 commit、错误兜底）。
 * sink 与泵通过「初始 sessionId + streamId」配对：
 *
 * - 泵全程用初始 sid（新建时为前端临时 id）盖事件的 sessionId 戳；sink 注册表按该键路由
 * - streamId 单调递增防串：同 session 重跑时，旧泵残留迟到事件 streamId 不匹配当前
 *   sink 直接丢弃（被丢弃旧 run 的取消标记由服务端落库侧 waitRunError 兜底）
 * - sink 另存 storeSid（store 写回键）：START 回传真实 id 后切过去
 *   （经 store 的 migrateSessionRuntime）
 *
 * 停止按钮不变量之一落在 startSessionSink：泵的 AbortController 必须经
 * setSessionAbortController 注册进 store 桶 —— 停止按钮 abort 的正是它。
 */

import { v4 as uuidv4 } from 'uuid';

import { ClientAgentEventType } from '@/events/protocol/client-event';
import type { EventBus, RoutedClientAgentEvent } from '@/events/client';
import useChatSessionStore, { type SessionRunStatus } from '@/store/chat-session-store';
import type { TitleUpdatePayload } from '@/deerflow-harness';
import { createRafFlusher, type RafFlusher } from '@/utils/common';
import type { ChatMessageType, ChatSessionType, ChatUploadedFileRef } from '@/types';
import type { RunOperation } from './chat-request-body';
import { buildAttachmentParts } from './attachment-parts';
import {
  appendCancelledPart,
  appendStandaloneText,
  createPartsStateFromExisting,
  finalizePartsState,
  initialPartsState,
  reducePartsState,
  type PartsState,
} from './parts-reducer';

export interface StartSinkOptions {
  operation?: RunOperation;
  inputValue: string;
  resumeDecision?: string;
  uploadedFiles?: ChatUploadedFileRef[];
  /** 泵键（初始 sessionId；新建时为前端临时 id，全程不变，只作路由） */
  sessionId: string;
  isNewSession: boolean;
  streamId: number;
  controller: AbortController;
  /** rAF 合帧器工厂（测试注入同步版；缺省 createRafFlusher） */
  flusherFactory?: (commit: () => void) => RafFlusher;
}

interface SessionSink {
  /** 路由键：泵的初始 sid，全程不变 */
  sessionId: string;
  /** store 写回键：START 后切到后端真实 id */
  storeSid: string;
  streamId: number;
  operation?: RunOperation;
  inputValue: string;
  assistantMessageId: string;
  initialUpdateMessages: ChatMessageType[];
  state: PartsState;
  /** 本轮终态：正常 done / 出错 error / 被用户中止 idle。finish 时落桶。 */
  finalStatus: SessionRunStatus;
  flusher: RafFlusher;
}

const sinks = new Map<string, SessionSink>();
let detachFromBus: (() => void) | null = null;

/**
 * 把 sink 挂到 EventBus（通配订阅，幂等：重复挂载先 detach 旧订阅）。
 * 返回 detach 函数（Provider effect cleanup 使用）。
 */
export function attachSinkToBus(bus: EventBus): () => void {
  detachFromBus?.();
  const off = bus.on('*', routeEvent);
  detachFromBus = off;
  return () => {
    if (detachFromBus === off) detachFromBus = null;
    off();
  };
}

/**
 * 决定本轮泵的会话键（迁移自旧 chatWithAgent 的入口逻辑）：
 * - 有 sessionId（含当前视图）→ 复用，isNewSession=false
 * - 无 sessionId → 生成前端临时 id；普通发送（无 operation）才切为当前视图
 *   （resume/recall 等 operation 不切，对齐旧行为）
 */
export function resolveRunSessionId(opts: { sessionId?: string; operation?: RunOperation }): {
  sessionId: string;
  isNewSession: boolean;
} {
  const store = useChatSessionStore.getState();
  // currentSessionId 是 UUIDTypes（string | Uint8Array），显式收窄为 string 供分拣用
  let sessionId = opts.sessionId ?? (store.currentSessionId ? String(store.currentSessionId) : '');
  let isNewSession = false;
  if (!sessionId) {
    sessionId = uuidv4();
    isNewSession = true;
    if (opts.operation === undefined) {
      store.setCurrentSessionId(sessionId);
    }
  }
  return { sessionId, isNewSession };
}

/**
 * 开启一轮 sink：占位消息 + 控制器/运行态注册（迁移自旧 handler 的
 * handleSession / setupAbortController / initializeMessages / reInitializeMessages /
 * resumeMessages）。返回 false 表示空输入早退（对齐旧 execute() 的守卫：不发请求）。
 */
export function startSessionSink(opts: StartSinkOptions): boolean {
  if (opts.inputValue === '' && opts.operation !== 'resume') return false;

  const store = useChatSessionStore.getState();
  const sid = opts.sessionId;

  // 先注册控制器与 running 态，再写占位消息（与旧 handler 的执行顺序一致）
  store.setSessionAbortController(sid, opts.controller);
  store.setSessionStatus(sid, 'running');

  // 按桶读消息而非 currentMessages 投影：operation（recall/reEditCall/resume）的
  // 目标会话桶是权威数据，投影可能已被切走的视图污染。
  const messages = store.getSessionRuntime(sid)?.messages ?? [];
  const { state, assistantMessageId, initialUpdateMessages } = buildInitialMessages(opts, messages);

  const sink: SessionSink = {
    sessionId: sid,
    storeSid: sid,
    streamId: opts.streamId,
    operation: opts.operation,
    inputValue: opts.inputValue,
    assistantMessageId,
    initialUpdateMessages,
    state,
    finalStatus: 'done',
    flusher: (opts.flusherFactory ?? createRafFlusher)(() => commitFlush(sink)),
  };
  sinks.set(sid, sink);
  store.setSessionMessages(sid, initialUpdateMessages);
  store.setShouldAutoScroll(true);
  return true;
}

/**
 * 收尾：把终态落桶并清掉控制器。非当前 streamId 的调用 no-op —— 旧泵被 supersede
 * 后的迟到收尾不能误伤新 sink。
 */
export function finishSessionSink(sessionId: string, streamId: number): void {
  const sink = sinks.get(sessionId);
  if (!sink || sink.streamId !== streamId) return;
  sinks.delete(sessionId);
  // 兜底 flush：流若未以 END 正常收尾（断流、HTTP 错误等），把最后一帧落桶
  sink.flusher.flushSync();
  const store = useChatSessionStore.getState();
  store.setSessionStatus(sink.storeSid, sink.finalStatus);
  store.setSessionAbortController(sink.storeSid, null);
}

/**
 * 三类占位消息初始化（逻辑与旧 handler 三个 private 方法一一对应）：
 * - 普通发送：追加 user 占位 + 空 assistant 占位
 * - resume：用上一轮 assistant parts 构造 PartsState 继续累积，顶层 interrupt 清空
 * - recall：重置最后一条 assistant；reEditCall：覆盖最近 user + 重置最后一条 assistant
 */
function buildInitialMessages(
  opts: StartSinkOptions,
  messages: ChatMessageType[],
): {
  state: PartsState;
  assistantMessageId: string;
  initialUpdateMessages: ChatMessageType[];
} {
  if (opts.operation === undefined) {
    const userMessage: ChatMessageType = {
      id: uuidv4(),
      sessionId: opts.sessionId,
      role: 'user',
      parts: [
        {
          partId: uuidv4(),
          type: 'text',
          createdAt: Date.now(),
          content: { text: opts.inputValue },
        },
        ...buildAttachmentParts(opts.uploadedFiles),
      ],
      createdAt: Date.now(),
    };

    const assistantMessageId = uuidv4();
    const assistantMessage: ChatMessageType = {
      id: assistantMessageId,
      sessionId: opts.sessionId,
      role: 'assistant',
      parts: [],
      createdAt: Date.now(),
    };

    return {
      state: initialPartsState,
      assistantMessageId,
      initialUpdateMessages: [...messages, userMessage, assistantMessage],
    };
  }

  if (opts.operation === 'resume') {
    const last = messages[messages.length - 1];
    let state: PartsState;
    let assistantMessageId: string;
    if (last?.role === 'assistant' && Array.isArray(last.parts)) {
      state = createPartsStateFromExisting(last.parts);
      assistantMessageId = String(last.id);
    } else {
      state = initialPartsState;
      assistantMessageId = String(last?.id ?? uuidv4());
    }
    return {
      state,
      assistantMessageId,
      initialUpdateMessages: messages.map((message, idx) =>
        idx === messages.length - 1 && message.role === 'assistant'
          ? { ...message, parts: [...state.parts], interrupt: null }
          : message,
      ),
    };
  }

  // recall / reEditCall
  const len = messages.length;
  const lastAssistant = messages[len - 1];
  const assistantMessageId = String(lastAssistant?.id ?? uuidv4());

  if (opts.operation === 'recall') {
    return {
      state: initialPartsState,
      assistantMessageId,
      initialUpdateMessages: [
        ...messages.slice(0, len - 1),
        { ...lastAssistant, id: assistantMessageId, parts: [], interrupt: null },
      ],
    };
  }

  // reEditCall：覆盖最近的 user message + 重置最后一条 assistant
  const lastUser = messages[len - 2];
  const replacedUser: ChatMessageType = {
    ...lastUser,
    parts: [
      {
        partId: uuidv4(),
        type: 'text',
        createdAt: Date.now(),
        content: { text: opts.inputValue },
      },
    ],
  };
  return {
    state: initialPartsState,
    assistantMessageId,
    initialUpdateMessages: [
      ...messages.slice(0, len - 2),
      replacedUser,
      { ...lastAssistant, id: assistantMessageId, parts: [], interrupt: null },
    ],
  };
}

/** 通配订阅入口：按 ev.sessionId 分拣 + streamId 防串，其余交给事件分支。 */
function routeEvent(ev: RoutedClientAgentEvent): void {
  const sink = sinks.get(ev.sessionId);
  if (!sink || sink.streamId !== ev.streamId) return;

  switch (ev.eventType) {
    case ClientAgentEventType.START:
      applyStartEvent(sink, ev.payload);
      return;
    case ClientAgentEventType.ERROR:
      handleError(sink, ev.payload);
      return;
    case ClientAgentEventType.END: {
      // 后端可能在 END 上挂 titleUpdate（autoTitle 异步落库后的最终标题）。
      // 在 finalize parts 之前先应用，避免侧栏列表展示落后一帧。
      applyEndTitleUpdate(sink, ev.payload);
      const finalized = finalizePartsState(sink.state, sink.inputValue ?? '');
      sink.state = {
        ...sink.state,
        parts: finalized.parts,
        lastPartType: finalized.parts[finalized.parts.length - 1]?.type ?? sink.state.lastPartType,
        interrupt: finalized.interrupt,
      };
      sink.flusher.flushSync();
      return;
    }
    // HEARTBEAT 不入 parts、也无需触发重渲染
    case ClientAgentEventType.HEARTBEAT:
      return;
    default: {
      const next = reducePartsState(sink.state, ev);
      if (next !== sink.state) {
        sink.state = next;
        sink.flusher.schedule();
      }
    }
  }
}

/**
 * 处理 START 事件：把临时 sessionId / 占位 messageId 替换为后端下发的真实 id，
 * 并在新会话时把 chatSession 注入侧边栏列表。
 */
function applyStartEvent(
  sink: SessionSink,
  payload: {
    sessionId?: string;
    chatSession?: ChatSessionType;
    userMessageId?: string;
    assistantMessageId?: string;
  },
): void {
  const {
    sessionId: realSessionId,
    userMessageId: realUserId,
    assistantMessageId: realAssistantId,
    chatSession,
  } = payload;
  const tempSessionId = sink.sessionId;
  const tempAssistantId = sink.assistantMessageId;
  const store = useChatSessionStore.getState();

  if (realSessionId && realSessionId !== tempSessionId) {
    // 新建对话：把临时 id 桶迁移到后端真实 id 桶。migrate 内部仅当用户当前仍在看
    // 这个临时对话时才把 currentSessionId 切到真实 id——若用户已切走，则不打扰。
    store.migrateSessionRuntime(tempSessionId, realSessionId);
    sink.storeSid = realSessionId;
  }
  if (realAssistantId) {
    sink.assistantMessageId = realAssistantId;
  }

  rewriteMessageIds(sink, {
    tempSessionId,
    realSessionId,
    realUserId,
    tempAssistantId,
    realAssistantId,
  });
  addChatSession(sink, chatSession);
}

/**
 * 单次扫描 initialUpdateMessages：
 * - 把临时 sessionId 替换为真实 sessionId
 * - 把「最后一条 user」的临时 id 替换为 realUserId
 * - 把匹配 tempAssistantId 的 assistant 消息 id 替换为 realAssistantId
 */
function rewriteMessageIds(
  sink: SessionSink,
  params: {
    tempSessionId: string;
    realSessionId?: string;
    realUserId?: string;
    tempAssistantId: string;
    realAssistantId?: string;
  },
): void {
  const { tempSessionId, realSessionId, realUserId, tempAssistantId, realAssistantId } = params;
  if (!realSessionId && !realUserId && !realAssistantId) return;

  let lastUserIdx = -1;
  if (realUserId) {
    for (let i = sink.initialUpdateMessages.length - 1; i >= 0; i--) {
      if (sink.initialUpdateMessages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
  }

  let mutated = false;
  const updated = sink.initialUpdateMessages.map((message, idx) => {
    const patch: Partial<ChatMessageType> = {};
    if (realSessionId && message.sessionId === tempSessionId) patch.sessionId = realSessionId;
    if (realUserId && idx === lastUserIdx) patch.id = realUserId;
    if (realAssistantId && message.role === 'assistant' && message.id === tempAssistantId)
      patch.id = realAssistantId;
    if (Object.keys(patch).length === 0) return message;
    mutated = true;
    return { ...message, ...patch };
  });

  if (mutated) {
    sink.initialUpdateMessages = updated;
    useChatSessionStore.getState().setSessionMessages(sink.storeSid, updated);
  }
}

function addChatSession(sink: SessionSink, chatSession: ChatSessionType | undefined): void {
  if (!chatSession || typeof chatSession.id !== 'string') return;
  const store = useChatSessionStore.getState();
  store.addChatSession({
    id: chatSession.id,
    seq_id: chatSession.seq_id ?? store.chatSessions.length + 1,
    title: chatSession.title || sink.inputValue.slice(0, 15) || 'New thread',
    created_at: chatSession.created_at ?? Date.now(),
    updated_at: chatSession.updated_at ?? Date.now(),
  });
}

/** 处理 END 事件挂载的 titleUpdate（autoTitle 异步落库结果）：命中已有 session 直接替换标题 */
function applyEndTitleUpdate(
  sink: SessionSink,
  payload: { titleUpdate?: TitleUpdatePayload },
): void {
  if (!payload || typeof payload !== 'object') return;
  const titleUpdate = payload.titleUpdate;
  if (!titleUpdate || typeof titleUpdate !== 'object') return;
  const { sessionId, title, updatedAt } = titleUpdate;
  if (typeof sessionId !== 'string' || typeof title !== 'string') return;
  const store = useChatSessionStore.getState();
  const existing = store.chatSessions.find((s) => s.id === sessionId);
  if (existing) {
    store.updateChatSession(
      {
        ...existing,
        title,
        updated_at: typeof updatedAt === 'number' ? updatedAt : Date.now(),
      },
      'edit',
    );
  }
}

/**
 * 出错兜底（含用户取消）：与旧 handler.handleError 对齐，但按 ERROR 事件的
 * errorCode 判定（createAgentEventStream 已把 fetch abort / 网络错误统一成
 * ERROR 事件，AbortError 名兜底不再需要）。
 */
function handleError(
  sink: SessionSink,
  payload: { errorCode: string; errorMessage: string; recoverable?: boolean },
): void {
  if (payload.errorCode === 'AGENT_STREAM_ABORTED') {
    // 用户点了停止：已产出的内容原样保留，正文后单独一行「用户已取消」。
    // 不加这一行的话，模型还没吐出任何 token 时 parts 为空 —— 气泡的转圈条件正是
    // 「assistant 且 parts 为空」，于是会永远转圈停不下来。
    sink.state = appendCancelledPart(sink.state, '用户已取消');
    sink.flusher.flushSync();
    console.log('Chat was Interrupted by user');
    sink.finalStatus = 'idle';
    return;
  }
  console.error('Stream error:', payload.errorMessage);
  sink.finalStatus = 'error';
  sink.state = appendStandaloneText(sink.state, '出错了，哎嘿。');
  sink.flusher.flushSync();
}

/**
 * 把当前 state.parts 写回 store。
 *
 * 由于 reducer 是不变更新（结构共享），未变更的 part 引用保持稳定，直接 spread
 * 一层即可让 React 检测到 message 引用变化并重渲染。
 */
function commitFlush(sink: SessionSink): void {
  const target = sink.assistantMessageId;
  const partsSnapshot = [...sink.state.parts];
  const interruptSnapshot = sink.state.interrupt;
  let mutated = false;
  const updateMessages = sink.initialUpdateMessages.map((message) => {
    if (message.id !== target) return message;
    mutated = true;
    return {
      ...message,
      parts: partsSnapshot,
      interrupt: interruptSnapshot,
    };
  });
  if (!mutated) return;
  sink.initialUpdateMessages = updateMessages;
  useChatSessionStore.getState().setSessionMessages(sink.storeSid, updateMessages);
}
