import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EventBus } from '@/events/client';
import {
  ClientAgentEventType,
  createClientAgentEvent,
  type ClientAgentEvent,
  type StartPayload,
} from '@/events/protocol/client-event';
import useChatSessionStore from '@/store/chat-session-store';
import type { ChatMessageType, ChatSessionType, MessagePart } from '@/types';
import type { RafFlusher } from '@/utils/common';
import {
  attachSinkToBus,
  finishSessionSink,
  resolveRunSessionId,
  startSessionSink,
} from '../agent-event-sink';

/** node 环境无 rAF：schedule 立即 commit，测试无需等待帧。 */
function makeSyncFlusher(commit: () => void): RafFlusher {
  return {
    schedule: () => commit(),
    flushSync: () => commit(),
    cancel: () => {},
  };
}

function routed(event: ClientAgentEvent, sessionId: string, streamId: number) {
  return { ...event, sessionId, streamId };
}

function chunkEvent(text: string): ClientAgentEvent {
  return createClientAgentEvent(ClientAgentEventType.STREAM_CHUNK, 'lead', { text });
}

function startEvent(payload: StartPayload): ClientAgentEvent {
  return createClientAgentEvent(ClientAgentEventType.START, 'lead', payload);
}

function errorEvent(errorCode: string): ClientAgentEvent {
  return createClientAgentEvent(ClientAgentEventType.ERROR, 'lead', {
    errorCode,
    errorMessage: 'boom',
    recoverable: false,
  });
}

function endEvent(titleUpdate?: {
  sessionId: string;
  title: string;
  updatedAt: number;
}): ClientAgentEvent {
  return createClientAgentEvent(ClientAgentEventType.END, 'lead', { titleUpdate });
}

const textPart = (text: string): MessagePart => ({
  partId: 'p-1',
  type: 'text',
  createdAt: 1,
  content: { text },
});

const asMessage = (
  sessionId: string,
  id: string,
  role: 'user' | 'assistant',
  parts: MessagePart[],
): ChatMessageType => ({ id, sessionId, role, parts, createdAt: 1 }) as unknown as ChatMessageType;

const asSession = (id: string, title: string): ChatSessionType =>
  ({ id, seq_id: 1, title, created_at: 1, updated_at: 1 }) as unknown as ChatSessionType;

/** 聚合 assistant 消息里所有 text part 的文本（断言用）。 */
function textParts(parts: MessagePart[]): string[] {
  return parts.filter((p) => p.type === 'text').map((p) => p.content.text);
}

/** 起一个 sink（默认单会话 s1 / streamId 1），返回已挂 sink 的 bus。 */
function startSink(overrides: Record<string, unknown> = {}): EventBus {
  const bus = new EventBus();
  attachSinkToBus(bus);
  startSessionSink({
    inputValue: 'hi',
    sessionId: 's1',
    isNewSession: false,
    streamId: 1,
    controller: new AbortController(),
    flusherFactory: makeSyncFlusher,
    ...overrides,
  });
  return bus;
}

function bucket(sid = 's1') {
  return useChatSessionStore.getState().getSessionRuntime(sid);
}

beforeEach(() => {
  useChatSessionStore.setState({
    isChating: false,
    shouldAutoScroll: false,
    chatSessions: [],
    currentSessionId: '',
    currentMessages: [],
    currentAbortController: null,
    sessionRuntimes: {},
  });
});

describe('SessionStreamSink（store 写入者）', () => {
  it('普通发送：写占位消息并把 stream_chunk 累积进 assistant parts', () => {
    const bus = startSink();
    bus.emit(routed(chunkEvent('hello'), 's1', 1));
    bus.emit(routed(chunkEvent(' world'), 's1', 1));

    const runtime = bucket();
    expect(runtime?.status).toBe('running');
    expect(runtime?.messages).toHaveLength(2);
    expect(runtime?.messages[0].role).toBe('user');
    expect(textParts(runtime?.messages[0].parts ?? [])).toEqual(['hi']);
    const assistant = runtime?.messages[1];
    expect(assistant?.role).toBe('assistant');
    expect(textParts(assistant?.parts ?? [])).toEqual(['hello world']);
  });

  it('双会话交错：事件按 sessionId 分拣，各写各桶', () => {
    const bus = new EventBus();
    attachSinkToBus(bus);
    const mk = (sid: string, streamId: number) =>
      startSessionSink({
        inputValue: `hi-${sid}`,
        sessionId: sid,
        isNewSession: false,
        streamId,
        controller: new AbortController(),
        flusherFactory: makeSyncFlusher,
      });
    mk('a', 1);
    mk('b', 2);

    bus.emit(routed(chunkEvent('A1'), 'a', 1));
    bus.emit(routed(chunkEvent('B1'), 'b', 2));
    bus.emit(routed(chunkEvent('A2'), 'a', 1));

    expect(textParts(bucket('a')?.messages[1].parts ?? [])).toEqual(['A1A2']);
    expect(textParts(bucket('b')?.messages[1].parts ?? [])).toEqual(['B1']);
  });

  it('START：临时桶迁移到真实 id、消息 id 重写、chatSession 注入侧栏', () => {
    useChatSessionStore.getState().setCurrentSessionId('tmp-1');
    const bus = startSink({ sessionId: 'tmp-1', isNewSession: true });
    bus.emit(
      routed(
        startEvent({
          sessionId: 'real-1',
          userMessageId: 'u-real',
          assistantMessageId: 'a-real',
          chatSession: { id: 'real-1', seq_id: 1, title: '新会话', created_at: 1, updated_at: 1 },
        }),
        'tmp-1',
        1,
      ),
    );

    const s = useChatSessionStore.getState();
    expect(s.getSessionRuntime('tmp-1')).toBeNull();
    const runtime = s.getSessionRuntime('real-1');
    expect(runtime?.messages).toHaveLength(2);
    expect(runtime?.messages[0].id).toBe('u-real');
    expect(runtime?.messages[1].id).toBe('a-real');
    expect(runtime?.messages[0].sessionId).toBe('real-1');
    // migrate 内部把正在查看的临时视图切到真实 id
    expect(s.currentSessionId).toBe('real-1');
    expect(s.chatSessions.map((c) => c.id)).toContain('real-1');
  });

  it('取消（AGENT_STREAM_ABORTED）：追加 cancelled part，finish 后状态 idle', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bus = startSink();
    bus.emit(routed(chunkEvent('部分输出'), 's1', 1));
    bus.emit(routed(errorEvent('AGENT_STREAM_ABORTED'), 's1', 1));

    const parts = bucket()?.messages[1].parts ?? [];
    expect(parts.some((p) => p.type === 'cancelled')).toBe(true);
    expect(textParts(parts)).toEqual(['部分输出']);

    finishSessionSink('s1', 1);
    const s = useChatSessionStore.getState();
    expect(s.getSessionRuntime('s1')?.status).toBe('idle');
    expect(s.getSessionRuntime('s1')?.abortController).toBeNull();
    logSpy.mockRestore();
  });

  it('非取消 ERROR：追加兜底文本，finish 后状态 error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = startSink();
    bus.emit(routed(errorEvent('AGENT_STREAM_HTTP_ERROR'), 's1', 1));

    expect(textParts(bucket()?.messages[1].parts ?? [])).toEqual(['出错了，哎嘿。']);

    finishSessionSink('s1', 1);
    expect(bucket()?.status).toBe('error');
    errorSpy.mockRestore();
  });

  it('END：titleUpdate 落侧栏、parts 定稿；finish 后状态 done', () => {
    useChatSessionStore.getState().addChatSession(asSession('s1', '原标题'));
    const bus = startSink();
    bus.emit(routed(chunkEvent('回答'), 's1', 1));
    bus.emit(routed(endEvent({ sessionId: 's1', title: '自动生成标题', updatedAt: 123 }), 's1', 1));

    const s = useChatSessionStore.getState();
    expect(s.chatSessions.find((c) => c.id === 's1')?.title).toBe('自动生成标题');

    finishSessionSink('s1', 1);
    expect(bucket()?.status).toBe('done');
  });

  it('同 session 重跑：旧 streamId 迟到事件被丢弃，旧 finish no-op', () => {
    const bus = startSink({ streamId: 1 });
    // 新 sink 接管同一 session（模拟 supersede 后重新 run）
    startSessionSink({
      inputValue: '第二条',
      sessionId: 's1',
      isNewSession: false,
      streamId: 2,
      controller: new AbortController(),
      flusherFactory: makeSyncFlusher,
    });

    bus.emit(routed(chunkEvent('旧泵迟到事件'), 's1', 1));
    const messages = bucket()?.messages ?? [];
    expect(messages).toHaveLength(4); // 两轮 user+assistant 占位
    expect(textParts(messages[3].parts ?? [])).toEqual([]);

    finishSessionSink('s1', 1); // 旧泵收尾：no-op，不动新 sink 的 running 态
    expect(bucket()?.status).toBe('running');

    bus.emit(routed(chunkEvent('新泵事件'), 's1', 2));
    expect(textParts(bucket()?.messages[3].parts ?? [])).toEqual(['新泵事件']);

    finishSessionSink('s1', 2);
    expect(bucket()?.status).toBe('done');
  });

  it('空输入（非 resume）早退：不建桶、不注册控制器', () => {
    const ok = startSessionSink({
      inputValue: '',
      sessionId: 's1',
      isNewSession: false,
      streamId: 1,
      controller: new AbortController(),
      flusherFactory: makeSyncFlusher,
    });
    expect(ok).toBe(false);
    expect(bucket()).toBeNull();
  });

  it('resume：以既有 assistant parts 构造 PartsState 继续累积，interrupt 清空', () => {
    const store = useChatSessionStore.getState();
    store.setSessionMessages('s1', [
      asMessage('s1', 'u1', 'user', [textPart('原始问题')]),
      asMessage('s1', 'a1', 'assistant', [textPart('已有')]),
    ]);
    const bus = new EventBus();
    attachSinkToBus(bus);
    startSessionSink({
      operation: 'resume',
      inputValue: '',
      resumeDecision: '确认',
      sessionId: 's1',
      isNewSession: false,
      streamId: 1,
      controller: new AbortController(),
      flusherFactory: makeSyncFlusher,
    });

    bus.emit(routed(chunkEvent('继续'), 's1', 1));
    const messages = bucket()?.messages ?? [];
    expect(messages).toHaveLength(2);
    expect(textParts(messages[1].parts ?? [])).toEqual(['已有继续']);
    expect(messages[1].interrupt).toBeNull();
  });

  it('recall：重置最后一条 assistant 后重新累积', () => {
    const store = useChatSessionStore.getState();
    store.setSessionMessages('s1', [
      asMessage('s1', 'u1', 'user', [textPart('问题')]),
      asMessage('s1', 'a1', 'assistant', [textPart('旧回答')]),
    ]);
    const bus = new EventBus();
    attachSinkToBus(bus);
    startSessionSink({
      operation: 'recall',
      inputValue: '问题',
      sessionId: 's1',
      isNewSession: false,
      streamId: 1,
      controller: new AbortController(),
      flusherFactory: makeSyncFlusher,
    });

    bus.emit(routed(chunkEvent('新回答'), 's1', 1));
    const messages = bucket()?.messages ?? [];
    expect(messages).toHaveLength(2);
    expect(textParts(messages[1].parts ?? [])).toEqual(['新回答']);
  });
});

describe('resolveRunSessionId（泵会话键派生）', () => {
  it('无会话且普通发送：生成临时 id、切为当前视图；再次调用复用', () => {
    const fresh = resolveRunSessionId({});
    expect(fresh.isNewSession).toBe(true);
    expect(useChatSessionStore.getState().currentSessionId).toBe(fresh.sessionId);

    const reused = resolveRunSessionId({});
    expect(reused).toEqual({ sessionId: fresh.sessionId, isNewSession: false });
  });

  it('显式 sessionId：直接复用，不切视图', () => {
    const r = resolveRunSessionId({ sessionId: 's-explicit' });
    expect(r).toEqual({ sessionId: 's-explicit', isNewSession: false });
    expect(useChatSessionStore.getState().currentSessionId).toBe('');
  });

  it('operation 场景无会话：也生成临时 id 但不切当前视图（对齐旧行为）', () => {
    const withOp = resolveRunSessionId({ operation: 'recall' });
    expect(withOp.isNewSession).toBe(true);
    expect(useChatSessionStore.getState().currentSessionId).toBe('');
  });
});
