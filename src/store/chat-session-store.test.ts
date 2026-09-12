import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessageType, ChatSessionType } from '@/types';

import useChatSessionStore from './chat-session-store';

/**
 * 覆盖 updateChatSession(session, 'delete') 的两条关键不变量：
 *   1. 删除「非当前」对话，当前视图（消息 / isChating）绝不被殃及；
 *   2. 删除「当前」对话，投影与运行态必须一起归零 —— 否则桶已删、再没有路径把
 *      isChating 写回，输入框会永远卡在「停止」按钮上。
 */

const asSession = (id: string, title: string): ChatSessionType =>
  ({
    id,
    seq_id: Number(id),
    title,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
  }) as unknown as ChatSessionType;

const SESSION_A = asSession('1', '会话 A');
const SESSION_B = asSession('2', '会话 B');

const message = (sessionId: string, id: string): ChatMessageType =>
  ({
    id,
    sessionId,
    role: 'user',
    parts: [{ type: 'text', text: 'hi' }],
    createdAt: 1_700_000_000_000,
  }) as unknown as ChatMessageType;

const MESSAGE_A = message(String(SESSION_A.id), 'm-a');
const MESSAGE_B = message(String(SESSION_B.id), 'm-b');

const runtime = (messages: ChatMessageType[], abortController: AbortController | null) => ({
  messages,
  status: 'running' as const,
  abortController,
  lastActiveAt: 1,
});

beforeEach(() => {
  useChatSessionStore.setState({
    chatSessions: [SESSION_A, SESSION_B],
    currentSessionId: SESSION_A.id,
    currentMessages: [MESSAGE_A],
    isChating: true,
    currentAbortController: null,
    sessionRuntimes: {
      [String(SESSION_A.id)]: runtime([MESSAGE_A], null),
      [String(SESSION_B.id)]: runtime([MESSAGE_B], null),
    },
  });
});

describe('updateChatSession / delete', () => {
  it('删除非当前对话：只清掉该条与其运行桶，当前投影不受影响', () => {
    useChatSessionStore.getState().updateChatSession(SESSION_B, 'delete');

    const state = useChatSessionStore.getState();
    expect(state.chatSessions.map((s) => s.id)).toEqual([SESSION_A.id]);
    expect(state.currentSessionId).toBe(SESSION_A.id);
    expect(state.currentMessages).toEqual([MESSAGE_A]);
    expect(state.isChating).toBe(true);
    expect(state.sessionRuntimes[String(SESSION_B.id)]).toBeUndefined();
    expect(state.sessionRuntimes[String(SESSION_A.id)]).toBeDefined();
  });

  it('删除当前对话：列表、投影、isChating 一起归零，并中止其运行桶', () => {
    const abortController = new AbortController();
    const abortSpy = vi.spyOn(abortController, 'abort');
    useChatSessionStore.setState({
      currentAbortController: abortController,
      sessionRuntimes: {
        [String(SESSION_A.id)]: runtime([MESSAGE_A], abortController),
        [String(SESSION_B.id)]: runtime([MESSAGE_B], null),
      },
    });

    useChatSessionStore.getState().updateChatSession(SESSION_A, 'delete');

    const state = useChatSessionStore.getState();
    expect(state.chatSessions.map((s) => s.id)).toEqual([SESSION_B.id]);
    expect(state.currentSessionId).toBe('');
    expect(state.currentMessages).toEqual([]);
    expect(state.isChating).toBe(false);
    expect(state.currentAbortController).toBeNull();
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(state.sessionRuntimes[String(SESSION_A.id)]).toBeUndefined();
    // 其它对话的桶必须原样保留
    expect(state.sessionRuntimes[String(SESSION_B.id)]).toEqual(runtime([MESSAGE_B], null));
  });
});
